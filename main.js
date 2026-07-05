import * as THREE from 'three';
import { pass, mrt, normalView, builtinAOContext, screenUV } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { WoodNodeMaterial } from 'three/addons/materials/WoodNodeMaterial.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import Box3D from 'box3d.js/inline';
import { createMP4 } from './mp4.js';

const SPIN_SPEED = 8; // rad/s
const MOTOR_TORQUE = 300;
const DENSITY = 100;
const GRID_SNAP = 0.1;
const SIZE_SNAP = 0.05;
const TIME_STEP = 1 / 60;
const TOY_GAP = 0.8; // spacing between toys in play mode
const STORAGE_KEY = 'toys';
const REC_FPS = 60;
const REC_FRAMES = REC_FPS * 5; // five seconds of play

const Y_AXIS = new THREE.Vector3( 0, 1, 0 );
const Z_AXIS = new THREE.Vector3( 0, 0, 1 );

const TYPES = {
	block: {
		name: 'Block',
		kind: 'box',
		defaultSize: { x: 0.5, y: 0.5, z: 0.5 },
		wood: [ 'maple', 'semigloss' ],
		mountAxis: Y_AXIS, mountDepth: 0.25,
		friction: 0.6, restitution: 0.05,
		icon: '<rect x="10" y="10" width="28" height="28" rx="7"/>'
	},
	plank: {
		name: 'Plank',
		kind: 'box',
		defaultSize: { x: 1.2, y: 0.15, z: 0.45 },
		wood: [ 'teak', 'semigloss' ],
		mountAxis: Y_AXIS, mountDepth: 0.075,
		friction: 0.6, restitution: 0.05,
		icon: '<rect x="4" y="18" width="40" height="12" rx="5"/>'
	},
	wheel: {
		name: 'Wheel',
		kind: 'cylinder',
		defaultSize: { radius: 0.24, width: 0.16 },
		wood: [ 'walnut', 'gloss' ],
		mountAxis: Z_AXIS, mountDepth: 0.08,
		friction: 1.0, restitution: 0.05,
		icon: '<circle cx="24" cy="24" r="16"/><circle cx="24" cy="24" r="4" fill="#77502b"/>'
	},
	ball: {
		name: 'Ball',
		kind: 'sphere',
		defaultSize: { radius: 0.24 },
		wood: [ 'cherry', 'gloss' ],
		mountAxis: Y_AXIS, mountDepth: 0.24,
		friction: 0.7, restitution: 0.55,
		icon: '<circle cx="24" cy="24" r="15"/>'
	}
};

const TYPE_KEYS = Object.keys( TYPES );

const HANDLE_DIRS = [
	new THREE.Vector3( 1, 0, 0 ), new THREE.Vector3( - 1, 0, 0 ),
	new THREE.Vector3( 0, 1, 0 ), new THREE.Vector3( 0, - 1, 0 ),
	new THREE.Vector3( 0, 0, 1 ), new THREE.Vector3( 0, 0, - 1 )
];

// fingers need bigger targets than cursors

const GIZMO_SCALE = window.matchMedia( '(pointer: coarse)' ).matches ? 1.8 : 1;

let b3 = null;
let groundMesh = null; // box3d mesh data for the cup, shared by every world
let eventsBuffer = null;
let hitEvent = null;
let audio = null;
let recording = null;
let shareUrl = '';
let shareVideoUrl = null;
let scene, camera, renderer, controls, postProcessing;

let mode = 'build';
let toys = [];
let activeToy = null;
let focusToy = null; // camera focus in play mode, null = all toys
let selected = null;
let handles = [];
let drag = null;
let resize = null;
let pivotDrag = null;
let moveDrag = null;
let physics = null;
let physicsAcc = 0;
let restoring = false;
let viewingShared = false; // bench loaded from someone's link

const clock = new THREE.Clock();
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const groundPlane = new THREE.Plane( Y_AXIS, 0 );

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

const ghostMaterial = new THREE.MeshStandardMaterial( { transparent: true, opacity: 0.5, depthWrite: false, roughness: 0.8 } );
const ringMaterial = new THREE.MeshBasicMaterial( { color: 0xff9f2e, transparent: true, opacity: 0.6, depthWrite: false } );
const dotMaterial = new THREE.MeshStandardMaterial( { color: 0xff9f2e, emissive: 0xff9f2e, emissiveIntensity: 0.25, roughness: 0.35 } );
const dotGeometry = new THREE.SphereGeometry( 0.035, 12, 8 );
const markerGeometry = new THREE.SphereGeometry( 0.055, 16, 12 );
const markerMaterial = new THREE.MeshStandardMaterial( { color: 0x3bb2a0, emissive: 0x3bb2a0, emissiveIntensity: 0.25, roughness: 0.35, depthTest: false } );
const handleGeometry = new THREE.ConeGeometry( 0.05, 0.12, 12 );
const handleMaterial = new THREE.MeshStandardMaterial( { color: 0xff8a2a, emissive: 0xff8a2a, emissiveIntensity: 0.25, roughness: 0.35, transparent: true, opacity: 0.95, depthTest: false } );
const handleHoverMaterial = new THREE.MeshStandardMaterial( { color: 0xffc36b, emissive: 0xffc36b, emissiveIntensity: 0.5, roughness: 0.35, depthTest: false } );

init().catch( ( error ) => {

	console.error( error );
	const loading = document.getElementById( 'loading' );
	if ( loading !== null ) loading.textContent = 'something broke: ' + error.message;

} );

async function init() {

	// no msaa — the gtao pass cannot gather from a multisampled depth
	// texture; fxaa at the end of the pipeline covers the antialiasing

	renderer = new THREE.WebGPURenderer( { antialias: false } );
	renderer.setPixelRatio( Math.min( window.devicePixelRatio, 2 ) );
	renderer.setSize( window.innerWidth, window.innerHeight );
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type = THREE.PCFShadowMap;
	renderer.toneMapping = THREE.NeutralToneMapping;
	document.body.appendChild( renderer.domElement );

	[ b3 ] = await Promise.all( [ Box3D(), renderer.init() ] );

	eventsBuffer = b3.createEventsBuffer();
	hitEvent = b3.createContactHitEvent();

	for ( const def of Object.values( TYPES ) ) {

		def.material = WoodNodeMaterial.fromPreset( def.wood[ 0 ], def.wood[ 1 ] );
		def.geometry = buildGeometry( def, def.defaultSize ); // ghost preview

	}

	scene = new THREE.Scene();
	scene.background = new THREE.Color( 0x9a8b70 );
	scene.fog = new THREE.Fog( 0x9a8b70, 20, 45 );

	camera = new THREE.PerspectiveCamera( 45, window.innerWidth / window.innerHeight, 0.1, 100 );
	camera.position.set( 3.6, 2.6, 4.6 );

	controls = new OrbitControls( camera, renderer.domElement );
	controls.target.set( 0, 0.4, 0 );
	controls.enableDamping = true;
	controls.dampingFactor = 0.08;
	controls.maxPolarAngle = Math.PI * 0.495;
	controls.minDistance = 2;
	controls.maxDistance = 18;

	const pmremGenerator = new THREE.PMREMGenerator( renderer );
	const environment = new RoomEnvironment();
	scene.environment = pmremGenerator.fromScene( environment ).texture;
	scene.environmentIntensity = 0.5;
	pmremGenerator.dispose();
	environment.dispose();

	// soft key from above; candela with inverse-square decay, about 2 lux at the
	// floor over a dim environment — a ~4:1 ratio so the shadow reads clearly

	const spot = new THREE.SpotLight( 0xfff1de, 100 );
	spot.position.set( 0, 7, 0 );
	spot.angle = 0.7;
	spot.penumbra = 1;
	spot.decay = 2;
	spot.castShadow = true;
	spot.shadow.mapSize.set( 1024, 1024 );
	spot.shadow.camera.near = 2;
	spot.shadow.camera.far = 12;
	spot.shadow.bias = - 0.0002;
	spot.shadow.normalBias = 0.02;
	spot.shadow.radius = 16;
	scene.add( spot );
	scene.add( spot.target );

	// a very wide cup: flat floor rolling up into a surrounding wall, cyc style

	const profile = [ new THREE.Vector2( 0, 0 ), new THREE.Vector2( 14, 0 ) ];

	for ( let i = 1; i <= 12; i ++ ) {

		const t = ( i / 12 ) * Math.PI / 2;
		profile.push( new THREE.Vector2( 14 + 6 * Math.sin( t ), 6 * ( 1 - Math.cos( t ) ) ) );

	}

	profile.push( new THREE.Vector2( 20, 14 ) );

	const groundGeometry = new THREE.LatheGeometry( profile, 96 );

	const ground = new THREE.Mesh(
		groundGeometry,
		new THREE.MeshStandardMaterial( { color: 0x9a8b70, roughness: 1, side: THREE.DoubleSide } )
	);
	ground.receiveShadow = true;
	scene.add( ground );

	// the same cup as a physics mesh — box3d meshes collide one-sided, and
	// the lathe winding faces away from the bowl, so flip the triangles

	const groundIndex = groundGeometry.index.array;
	const groundIndices = [];
	for ( let i = 0; i < groundIndex.length; i += 3 ) groundIndices.push( groundIndex[ i ], groundIndex[ i + 2 ], groundIndex[ i + 1 ] );

	groundMesh = b3.b3CreateMesh( Array.from( groundGeometry.attributes.position.array ), groundIndices );

	// scattered tiles on the floor, so you can tell where a toy is heading

	const tileCount = 420;
	const tiles = new THREE.InstancedMesh(
		new THREE.CircleGeometry( 0.5, 3 ).rotateX( - Math.PI / 2 ),
		new THREE.MeshStandardMaterial( { roughness: 1 } ),
		tileCount
	);

	const tileMatrix = new THREE.Matrix4();
	const tilePosition = new THREE.Vector3();
	const tileRotation = new THREE.Quaternion();
	const tileScale = new THREE.Vector3();
	const tileColor = new THREE.Color();

	for ( let i = 0; i < tileCount; i ++ ) {

		const radius = 13.5 * Math.sqrt( Math.random() );
		const angle = Math.random() * Math.PI * 2;
		const size = 0.05 + Math.random() * 0.07;

		tilePosition.set( Math.cos( angle ) * radius, 0.004, Math.sin( angle ) * radius );
		tileRotation.setFromAxisAngle( Y_AXIS, Math.random() * Math.PI * 2 );
		tileScale.set( size, 1, size );
		tileMatrix.compose( tilePosition, tileRotation, tileScale );
		tiles.setMatrixAt( i, tileMatrix );

		tileColor.setHex( 0x9a8b70 ).offsetHSL( 0, 0, ( Math.random() - 0.5 ) * 0.11 );
		tiles.setColorAt( i, tileColor );

	}

	tiles.receiveShadow = true;
	scene.add( tiles );

	// gtao: a normals + depth pre-pass drives the ao, the beauty pass applies
	// it to ambient light only via builtinAOContext, fxaa after tone mapping

	postProcessing = new THREE.RenderPipeline( renderer );

	const prePass = pass( scene, camera );
	prePass.setMRT( mrt( { output: normalView } ) );

	const aoPass = ao( prePass.getTextureNode( 'depth' ), prePass.getTextureNode(), camera );
	aoPass.resolutionScale = 0.5;
	aoPass.radius.value = 0.4;

	const scenePass = pass( scene, camera );
	scenePass.contextNode = builtinAOContext( aoPass.getTextureNode().sample( screenUV ).r );

	postProcessing.outputColorTransform = false;
	postProcessing.outputNode = fxaa( scenePass.getTextureNode().renderOutput() );

	buildPalette();
	bindEvents();
	addToy();
	loadFromHash();
	if ( allPieces().length === 0 ) loadLocal();
	else if ( viewingShared ) loadLocal( true ); // your toys tag along, benched
	updateHint();

	document.getElementById( 'loading' ).remove();
	renderer.setAnimationLoop( animate );

	// a shared link goes straight to the show

	if ( viewingShared && allPieces().length > 0 ) setMode( 'play' );

}

function buildGeometry( def, size ) {

	switch ( def.kind ) {

		case 'box': {

			const chamfer = Math.min( 0.055, Math.min( size.x, size.y, size.z ) * 0.3 );
			return new RoundedBoxGeometry( size.x, size.y, size.z, 2, chamfer );

		}

		case 'cylinder':
			return new THREE.CylinderGeometry( size.radius, size.radius, size.width, 28 ).rotateX( Math.PI / 2 );

		case 'sphere':
			return new THREE.SphereGeometry( size.radius, 32, 20 );

	}

}

// toys

function allPieces() {

	const list = [];

	for ( const toy of toys ) list.push( ...toy.pieces );

	return list;

}

function setActiveToy( toy ) {

	if ( toy === activeToy ) return;

	select( null );

	activeToy = toy;
	toy.visible = true; // editing a toy puts it on stage
	toys = toys.filter( ( t ) => t.pieces.length > 0 || t === toy );

	refreshVisibility();
	updateToysList();
	updateHint();

}

function addToy() {

	const toy = { pieces: [], visible: true };
	toys.push( toy );
	setActiveToy( toy );

}

function refreshVisibility() {

	for ( const toy of toys ) {

		const visible = mode === 'play' ? toy.visible : toy === activeToy;

		for ( const piece of toy.pieces ) piece.mesh.visible = visible;

	}

}

function appendEyeAction( button, toy ) {

	const eye = document.createElement( 'span' );
	eye.className = 'toy-eye';
	eye.textContent = toy.visible ? '●' : '○';
	eye.title = 'Show in play mode';

	eye.addEventListener( 'click', ( event ) => {

		event.stopPropagation();

		toy.visible = ! toy.visible;
		if ( toy.visible === false && focusToy === toy ) focusToy = null;

		if ( mode === 'play' ) resetPlay();

		refreshVisibility();
		updateToysList();

	} );

	button.appendChild( eye );

}

function updateToysList() {

	const container = document.getElementById( 'toys' );
	container.textContent = '';

	if ( mode === 'play' ) {

		// in play the list picks which toy the camera follows

		const all = document.createElement( 'button' );
		all.className = 'toy-btn' + ( focusToy === null ? ' active' : '' );
		all.textContent = 'All toys';
		all.addEventListener( 'click', () => { focusToy = null; updateToysList(); } );
		container.appendChild( all );

		toys.forEach( ( toy, index ) => {

			if ( toy.pieces.length === 0 ) return;

			const button = document.createElement( 'button' );
			button.className = 'toy-btn' + ( toy === focusToy ? ' active' : '' );
			button.addEventListener( 'click', () => { if ( toy.visible ) { focusToy = toy; updateToysList(); } } );

			appendEyeAction( button, toy );

			const label = document.createElement( 'span' );
			label.className = 'toy-label';
			label.textContent = `Toy ${ index + 1 }`;
			button.appendChild( label );

			container.appendChild( button );

		} );

		return;

	}

	toys.forEach( ( toy, index ) => {

		const button = document.createElement( 'button' );
		button.className = 'toy-btn' + ( toy === activeToy ? ' active' : '' );
		button.addEventListener( 'click', () => setActiveToy( toy ) );

		appendEyeAction( button, toy );

		const label = document.createElement( 'span' );
		label.className = 'toy-label';
		label.textContent = `Toy ${ index + 1 } · ${ toy.pieces.length }`;
		button.appendChild( label );

		const del = document.createElement( 'span' );
		del.className = 'toy-del';
		del.textContent = '✕';
		del.addEventListener( 'click', ( event ) => { event.stopPropagation(); deleteToy( toy ); } );
		button.appendChild( del );

		container.appendChild( button );

	} );

	const add = document.createElement( 'button' );
	add.className = 'toy-btn new';
	add.textContent = '+ New toy';
	add.addEventListener( 'click', addToy );
	container.appendChild( add );

}

function deleteToy( toy ) {

	if ( toy.pieces.length > 0 && ! window.confirm( 'Delete this toy?' ) ) return;

	select( null );

	for ( const piece of toy.pieces ) destroyPiece( piece );
	toy.pieces = [];

	toys = toys.filter( ( t ) => t !== toy );

	if ( toys.length === 0 ) addToy();
	else if ( activeToy === toy ) setActiveToy( toys[ 0 ] );
	else updateToysList();

	saveLocal();
	updateHint();

}

function toyOf( piece ) {

	for ( const toy of toys ) {

		if ( toy.pieces.includes( piece ) ) return toy;

	}

	return null;

}

// sharing

function serializeToy( toy ) {

	const r3 = ( value ) => Math.round( value * 1000 ) / 1000;

	return toy.pieces.map( ( piece ) => {

		const size = piece.size;
		const kind = TYPES[ piece.type ].kind;
		const sizeArray = kind === 'box' ? [ size.x, size.y, size.z ] : kind === 'cylinder' ? [ size.radius, size.width ] : [ size.radius ];

		return [
			TYPE_KEYS.indexOf( piece.type ),
			toy.pieces.indexOf( piece.parent ), // -1 for the toy root
			piece.spin,
			r3( piece.position.x ), r3( piece.position.y ), r3( piece.position.z ),
			piece.attachNormal.x, piece.attachNormal.y, piece.attachNormal.z,
			...sizeArray.map( r3 ),
			r3( piece.pivot.x ), r3( piece.pivot.y ), r3( piece.pivot.z )
		];

	} );

}

function serializeToys( visibleOnly = false ) {

	return toys.filter( ( toy ) => toy.pieces.length > 0 && ( visibleOnly === false || toy.visible ) ).map( serializeToy );

}

function buildShareUrl() {

	// only what is on stage gets shared — benched toys stay private

	const url = new URL( location.href );
	url.hash = btoa( JSON.stringify( serializeToys( true ) ) ).replaceAll( '+', '-' ).replaceAll( '/', '_' ).replace( /=+$/, '' );
	return url.href;

}

// share: record a few seconds of play, then show the clip and the link

function openShare() {

	if ( allPieces().length === 0 || recording !== null ) return;

	shareUrl = buildShareUrl();

	if ( mode !== 'play' ) setMode( 'play' );

	if ( 'VideoEncoder' in window ) {

		try {

			startRecording();
			return;

		} catch ( error ) {

			console.warn( 'recording unavailable', error );

		}

	}

	showShareModal( null );

}

function startRecording() {

	const source = renderer.domElement;
	const scale = Math.min( 1, 1280 / source.width );
	const width = Math.floor( source.width * scale / 2 ) * 2;
	const height = Math.floor( source.height * scale / 2 ) * 2;

	const canvas = document.createElement( 'canvas' );
	canvas.width = width;
	canvas.height = height;

	const rec = {
		canvas,
		context: canvas.getContext( '2d' ),
		width, height,
		chunks: [],
		codecConfig: null,
		frame: 0,
		startTime: performance.now(),
		finishing: false,
		encoder: null
	};

	rec.encoder = new VideoEncoder( {

		output: ( chunk, metadata ) => {

			if ( metadata && metadata.decoderConfig && metadata.decoderConfig.description ) {

				rec.codecConfig = new Uint8Array( metadata.decoderConfig.description );

			}

			const data = new Uint8Array( chunk.byteLength );
			chunk.copyTo( data );
			rec.chunks.push( { data, timestamp: chunk.timestamp, type: chunk.type } );

		},

		error: ( error ) => {

			console.error( 'VideoEncoder error:', error );

			if ( recording === rec ) {

				abortRecording();
				showShareModal( null );

			}

		}

	} );

	rec.encoder.configure( {
		codec: 'avc1.640028',
		width, height,
		bitrate: 8e6,
		framerate: REC_FPS,
		avc: { format: 'avc' }
	} );

	recording = rec;
	document.getElementById( 'recBadge' ).hidden = false;

}

function captureFrame() {

	const rec = recording;

	// pace the live canvas down to a steady REC_FPS

	const elapsed = ( performance.now() - rec.startTime ) / 1000;
	if ( elapsed < rec.frame / REC_FPS ) return;

	rec.context.drawImage( renderer.domElement, 0, 0, rec.width, rec.height );

	const frame = new VideoFrame( rec.canvas, { timestamp: rec.frame * ( 1e6 / REC_FPS ) } );
	rec.encoder.encode( frame, { keyFrame: rec.frame % REC_FPS === 0 } );
	frame.close();

	rec.frame ++;
	document.getElementById( 'recBadge' ).textContent = `● recording · ${ ( rec.frame / REC_FPS ).toFixed( 1 ) }s`;

	if ( rec.frame >= REC_FRAMES ) finishRecording();

}

async function finishRecording() {

	const rec = recording;
	rec.finishing = true;
	document.getElementById( 'recBadge' ).hidden = true;

	try {

		await rec.encoder.flush();

		if ( rec.aborted === true ) return; // mode changed while flushing

		rec.encoder.close();

		const mp4 = createMP4( rec.chunks, rec.codecConfig, rec.width, rec.height, REC_FPS );
		recording = null;
		showShareModal( new Blob( [ mp4 ], { type: 'video/mp4' } ) );

	} catch ( error ) {

		console.error( error );
		recording = null;
		if ( rec.aborted !== true ) showShareModal( null );

	}

}

function abortRecording() {

	if ( recording === null ) return;

	recording.aborted = true;

	try { recording.encoder.close(); } catch ( error ) { /* already closed */ }

	recording = null;
	document.getElementById( 'recBadge' ).hidden = true;

}

function showShareModal( blob ) {

	const stage = document.getElementById( 'shareStage' );
	const video = document.getElementById( 'shareVideo' );

	if ( shareVideoUrl !== null ) URL.revokeObjectURL( shareVideoUrl );
	shareVideoUrl = null;

	if ( blob !== null ) {

		shareVideoUrl = URL.createObjectURL( blob );
		video.src = shareVideoUrl;
		document.getElementById( 'downloadBtn' ).href = shareVideoUrl;

	}

	stage.hidden = blob === null;

	document.getElementById( 'shareLink' ).value = shareUrl;
	document.getElementById( 'shareModal' ).hidden = false;

}

function closeShareModal() {

	const video = document.getElementById( 'shareVideo' );
	video.pause();
	video.removeAttribute( 'src' );

	if ( shareVideoUrl !== null ) URL.revokeObjectURL( shareVideoUrl );
	shareVideoUrl = null;

	document.getElementById( 'shareModal' ).hidden = true;

}

function loadToys( data, hidden = false ) {

	restoring = true;

	for ( const rows of data ) {

		addToy();
		if ( hidden ) activeToy.visible = false;

		for ( const row of rows ) {

			const [ typeIndex, parentIndex, spin, x, y, z, nx, ny, nz, ...rest ] = row;

			const type = TYPE_KEYS[ typeIndex ];
			const def = TYPES[ type ];
			const normal = new THREE.Vector3( nx, ny, nz );

			const placement = {
				position: new THREE.Vector3( x, y, z ),
				quaternion: new THREE.Quaternion().setFromUnitVectors( def.mountAxis, normal ),
				normal
			};

			const piece = addPiece( type, placement, parentIndex >= 0 ? activeToy.pieces[ parentIndex ] : null );

			if ( def.kind === 'box' ) piece.size = { x: rest[ 0 ], y: rest[ 1 ], z: rest[ 2 ] };
			else if ( def.kind === 'cylinder' ) piece.size = { radius: rest[ 0 ], width: rest[ 1 ] };
			else piece.size = { radius: rest[ 0 ] };

			const sizeCount = def.kind === 'box' ? 3 : def.kind === 'cylinder' ? 2 : 1;
			if ( rest.length >= sizeCount + 3 ) piece.pivot.set( rest[ sizeCount ], rest[ sizeCount + 1 ], rest[ sizeCount + 2 ] );

			piece.mesh.geometry.dispose();
			piece.mesh.geometry = buildGeometry( def, piece.size );

			if ( spin !== 0 ) setSpin( piece, spin );

		}

	}

	restoring = false;

	setActiveToy( toys[ 0 ] );

}

function loadFromHash() {

	const hash = location.hash.slice( 1 );
	if ( hash === '' ) return;

	try {

		loadToys( JSON.parse( atob( hash.replaceAll( '-', '+' ).replaceAll( '_', '/' ) ) ) );
		viewingShared = true;

	} catch ( error ) {

		console.warn( 'could not load toys from url', error );

	} finally {

		restoring = false;

	}

}

function saveLocal() {

	if ( restoring ) return;

	// an edit makes the bench yours again — drop any shared-link hash

	if ( location.hash !== '' ) history.replaceState( null, '', location.pathname + location.search );

	try {

		if ( allPieces().length > 0 ) localStorage.setItem( STORAGE_KEY, JSON.stringify( serializeToys() ) );
		else localStorage.removeItem( STORAGE_KEY );

	} catch ( error ) {

		// storage unavailable — not fatal

	}

}

function loadLocal( hidden = false ) {

	try {

		const json = localStorage.getItem( STORAGE_KEY );
		if ( json !== null ) loadToys( JSON.parse( json ), hidden );

	} catch ( error ) {

		console.warn( 'could not load saved toys', error );

	} finally {

		restoring = false;

	}

}

// UI

function buildPalette() {

	const palette = document.getElementById( 'palette' );

	for ( const [ type, def ] of Object.entries( TYPES ) ) {

		const item = document.createElement( 'div' );
		item.className = 'piece-btn';
		item.innerHTML = `<svg viewBox="0 0 48 48">${ def.icon }</svg>${ def.name }`;
		item.addEventListener( 'pointerdown', ( event ) => startDrag( event, type ) );
		palette.appendChild( item );

	}

}

function bindEvents() {

	const canvas = renderer.domElement;
	let downX = 0, downY = 0;

	// capture phase, so a grab on a pivot pin, resize handle or piece wins
	// over OrbitControls — checked in that order

	window.addEventListener( 'pointerdown', onPivotStart, true );
	window.addEventListener( 'pointerdown', onResizeStart, true );
	window.addEventListener( 'pointerdown', onMoveStart, true );

	canvas.addEventListener( 'pointerdown', ( event ) => {

		downX = event.clientX;
		downY = event.clientY;

	} );

	canvas.addEventListener( 'pointermove', ( event ) => {

		if ( mode !== 'build' || handles.length === 0 || drag !== null || resize !== null ) return;

		setRayFromEvent( event );
		const hits = raycaster.intersectObjects( handles, false );

		for ( const handle of handles ) handle.material = handleMaterial;
		if ( hits.length > 0 ) hits[ 0 ].object.material = handleHoverMaterial;

		let cursor = hits.length > 0 ? 'grab' : '';

		if ( cursor === '' && selected !== null && selected.indicator !== null ) {

			if ( raycaster.intersectObject( selected.indicator.marker, false ).length > 0 ) cursor = 'grab';

		}

		canvas.style.cursor = cursor;

	} );

	canvas.addEventListener( 'pointerup', ( event ) => {

		if ( drag !== null ) return;
		if ( Math.hypot( event.clientX - downX, event.clientY - downY ) > 6 ) return;

		setRayFromEvent( event );

		if ( mode === 'play' ) {

			// click a toy to follow it, click the floor for the wide shot

			const hits = raycaster.intersectObjects( allPieces().map( ( p ) => p.mesh ), false );
			focusToy = hits.length > 0 ? toyOf( hits[ 0 ].object.userData.piece ) : null;
			updateToysList();
			return;

		}

		const hits = raycaster.intersectObjects( activeToy.pieces.map( ( p ) => p.mesh ), false );
		select( hits.length > 0 ? hits[ 0 ].object.userData.piece : null );

	} );

	document.getElementById( 'buildBtn' ).addEventListener( 'click', ( event ) => { setMode( 'build' ); event.target.blur(); } );
	document.getElementById( 'playBtn' ).addEventListener( 'click', ( event ) => { setMode( 'play' ); event.target.blur(); } );
	document.getElementById( 'resetBtn' ).addEventListener( 'click', ( event ) => { resetPlay(); event.target.blur(); } );
	document.getElementById( 'shareBtn' ).addEventListener( 'click', ( event ) => { openShare(); event.target.blur(); } );
	document.getElementById( 'closeShareBtn' ).addEventListener( 'click', closeShareModal );

	document.getElementById( 'shareModal' ).addEventListener( 'click', ( event ) => {

		if ( event.target === event.currentTarget ) closeShareModal();

	} );

	document.getElementById( 'copyLinkBtn' ).addEventListener( 'click', ( event ) => {

		if ( navigator.clipboard ) navigator.clipboard.writeText( document.getElementById( 'shareLink' ).value );
		event.target.textContent = 'Copied!';
		setTimeout( () => { event.target.textContent = 'Copy'; }, 1500 );

	} );
	document.getElementById( 'spinBtn' ).addEventListener( 'click', cycleSpin );
	document.getElementById( 'duplicateBtn' ).addEventListener( 'click', duplicateSelected );
	document.getElementById( 'deleteBtn' ).addEventListener( 'click', deleteSelected );

	window.addEventListener( 'keydown', ( event ) => {

		if ( document.getElementById( 'shareModal' ).hidden === false ) {

			if ( event.code === 'Escape' ) closeShareModal();
			return;

		}

		if ( event.code === 'Space' ) {

			event.preventDefault();
			setMode( mode === 'build' ? 'play' : 'build' );
			return;

		}

		if ( event.code === 'KeyR' && mode === 'play' ) resetPlay();

		if ( mode !== 'build' ) return;

		if ( event.code === 'KeyS' && selected !== null ) cycleSpin();
		if ( event.code === 'KeyD' && selected !== null ) duplicateSelected();
		if ( ( event.code === 'Delete' || event.code === 'Backspace' ) && selected !== null ) deleteSelected();

		if ( event.code === 'Escape' ) {

			if ( moveDrag !== null ) cancelMoveDrag();
			else select( null );

		}

	} );

	window.addEventListener( 'resize', () => {

		camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();
		renderer.setSize( window.innerWidth, window.innerHeight );

	} );

}

function updateToolbar() {

	const toolbar = document.getElementById( 'toolbar' );
	toolbar.hidden = ! ( mode === 'build' && selected !== null );

	if ( selected !== null ) {

		const label = selected.spin === 0 ? 'Spin: off' : selected.spin === 1 ? 'Spin: ⟳' : 'Spin: ⟲';
		document.getElementById( 'spinBtn' ).textContent = label;

	}

}

function updateHint() {

	const hint = document.getElementById( 'hint' );

	if ( mode === 'play' ) {

		hint.textContent = 'click a toy to focus · R — reset · space — build';

	} else if ( activeToy === null || activeToy.pieces.length === 0 ) {

		hint.textContent = 'drag a piece onto the floor to start a toy';

	} else if ( selected !== null ) {

		hint.textContent = selected.spin !== 0
			? 'drag the pin to move the spin axis · handles resize · S — spin · delete — remove'
			: 'drag the orange handles to resize · S — spin · delete — remove · space — play';

	} else {

		hint.textContent = 'drag palette pieces to add · drag toy pieces to move · space — play';

	}

}

// build mode

function setRayFromEvent( event ) {

	pointer.set( ( event.clientX / window.innerWidth ) * 2 - 1, - ( event.clientY / window.innerHeight ) * 2 + 1 );
	raycaster.setFromCamera( pointer, camera );

}

function snapToAxis( normal ) {

	const ax = Math.abs( normal.x ), ay = Math.abs( normal.y ), az = Math.abs( normal.z );

	if ( ax >= ay && ax >= az ) return _v2.set( Math.sign( normal.x ), 0, 0 );
	if ( ay >= az ) return _v2.set( 0, Math.sign( normal.y ), 0 );
	return _v2.set( 0, 0, Math.sign( normal.z ) );

}

function computePlacement( def, point, normal, depth = def.mountDepth ) {

	const n = snapToAxis( normal );
	const position = point.clone();

	if ( Math.abs( n.x ) < 0.5 ) position.x = Math.round( position.x / GRID_SNAP ) * GRID_SNAP;
	if ( Math.abs( n.y ) < 0.5 ) position.y = Math.round( position.y / GRID_SNAP ) * GRID_SNAP;
	if ( Math.abs( n.z ) < 0.5 ) position.z = Math.round( position.z / GRID_SNAP ) * GRID_SNAP;

	position.addScaledVector( n, depth );

	const quaternion = new THREE.Quaternion().setFromUnitVectors( def.mountAxis, n );

	return { position, quaternion, normal: n.clone() };

}

function mountDepthFor( piece ) {

	const def = TYPES[ piece.type ];

	if ( def.kind === 'box' ) return piece.size.y / 2;
	if ( def.kind === 'cylinder' ) return piece.size.width / 2;

	return piece.size.radius;

}

function startDrag( event, type ) {

	if ( mode !== 'build' || drag !== null || resize !== null || pivotDrag !== null || moveDrag !== null ) return;

	event.preventDefault();

	const ghost = new THREE.Mesh( TYPES[ type ].geometry, ghostMaterial );
	ghost.visible = false;
	scene.add( ghost );

	drag = { type, ghost, placement: null, parent: null, valid: false };

	window.addEventListener( 'pointermove', onDragMove );
	window.addEventListener( 'pointerup', onDragEnd );
	window.addEventListener( 'pointercancel', onDragCancel );

	onDragMove( event );

}

function onDragCancel() {

	window.removeEventListener( 'pointermove', onDragMove );
	window.removeEventListener( 'pointerup', onDragEnd );
	window.removeEventListener( 'pointercancel', onDragCancel );

	scene.remove( drag.ghost );
	drag = null;
	updateHint();

}

function onDragMove( event ) {

	setRayFromEvent( event );

	const def = TYPES[ drag.type ];

	drag.placement = null;
	drag.parent = null;

	if ( activeToy.pieces.length > 0 ) {

		const hits = raycaster.intersectObjects( activeToy.pieces.map( ( p ) => p.mesh ), false );

		if ( hits.length > 0 ) {

			const hit = hits[ 0 ];
			const normal = hit.face.normal.clone().transformDirection( hit.object.matrixWorld );
			drag.placement = computePlacement( def, hit.point, normal );
			drag.parent = hit.object.userData.piece;

		}

	}

	if ( drag.placement === null && raycaster.ray.intersectPlane( groundPlane, _v1 ) !== null ) {

		drag.placement = computePlacement( def, _v1, Y_AXIS );

	}

	// the floor only accepts the first piece of a toy — new toys start from the list

	drag.valid = drag.placement !== null && ( activeToy.pieces.length === 0 || drag.parent !== null );

	if ( drag.placement !== null ) {

		drag.ghost.position.copy( drag.placement.position );
		drag.ghost.quaternion.copy( drag.placement.quaternion );
		drag.ghost.visible = true;
		ghostMaterial.color.setHex( drag.valid ? 0x59b87c : 0xd95f43 );

	} else {

		drag.ghost.visible = false;

	}

}

function onDragEnd( event ) {

	window.removeEventListener( 'pointermove', onDragMove );
	window.removeEventListener( 'pointerup', onDragEnd );
	window.removeEventListener( 'pointercancel', onDragCancel );

	scene.remove( drag.ghost );

	const overCanvas = document.elementFromPoint( event.clientX, event.clientY ) === renderer.domElement;

	if ( drag.valid && overCanvas ) {

		select( addPiece( drag.type, drag.placement, drag.parent ) );

	}

	drag = null;
	updateHint();

}

function addPiece( type, placement, parent ) {

	const def = TYPES[ type ];
	const size = { ...def.defaultSize };

	const mesh = new THREE.Mesh( buildGeometry( def, size ), def.material );
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	mesh.position.copy( placement.position );
	mesh.quaternion.copy( placement.quaternion );

	const piece = {
		type, mesh, parent, size,
		spin: 0,
		pivot: new THREE.Vector3(), // spin axis offset, local, ⊥ mount axis
		position: placement.position.clone(),
		quaternion: placement.quaternion.clone(),
		attachNormal: placement.normal.clone(),
		indicator: null
	};

	mesh.userData.piece = piece;
	activeToy.pieces.push( piece );
	scene.add( mesh );

	updateToysList();
	saveLocal();

	return piece;

}

function collectSubtree( piece ) {

	const list = [ piece ];

	for ( const other of activeToy.pieces ) {

		if ( other.parent === piece ) list.push( ...collectSubtree( other ) );

	}

	return list;

}

function destroyPiece( piece ) {

	scene.remove( piece.mesh );
	piece.mesh.geometry.dispose();
	if ( piece.indicator !== null ) piece.indicator.ring.geometry.dispose();

}

function select( piece ) {

	removeHandles();

	selected = piece;

	if ( piece !== null ) createHandles( piece );

	updateToolbar();
	updateHint();

}

function cycleSpin() {

	if ( selected === null ) return;

	setSpin( selected, selected.spin === 0 ? 1 : selected.spin === 1 ? - 1 : 0 );

}

function ringRadiusFor( piece ) {

	const size = piece.size;

	if ( TYPES[ piece.type ].kind === 'box' ) return Math.max( size.x, size.z ) / 2 + 0.08;

	return size.radius + 0.08;

}

function setSpin( piece, spin ) {

	piece.spin = spin;

	if ( piece.indicator !== null ) {

		piece.mesh.remove( piece.indicator.root );
		piece.indicator.ring.geometry.dispose();
		piece.indicator = null;

	}

	if ( spin !== 0 ) {

		const def = TYPES[ piece.type ];
		const radius = ringRadiusFor( piece ) + piece.pivot.length();

		const root = new THREE.Group();
		root.position.copy( piece.pivot );
		root.quaternion.setFromUnitVectors( Z_AXIS, def.mountAxis );

		const ring = new THREE.Mesh( new THREE.TorusGeometry( radius, 0.012, 8, 64 ), ringMaterial );
		root.add( ring );

		const pivot = new THREE.Group();
		const dot = new THREE.Mesh( dotGeometry, dotMaterial );
		dot.position.x = radius;
		pivot.add( dot );
		root.add( pivot );

		// the pin marking the spin axis — drag it to move the axis

		const marker = new THREE.Mesh( markerGeometry, markerMaterial );
		marker.scale.setScalar( GIZMO_SCALE );
		marker.renderOrder = 10;
		root.add( marker );

		root.visible = mode === 'build';
		piece.mesh.add( root );
		piece.indicator = { root, pivot, ring, marker };

	}

	updateToolbar();
	updateHint();
	saveLocal();

}

function clonePiece( old, parent, placement, spin, pivot ) {

	const piece = addPiece( old.type, placement, parent );

	piece.size = { ...old.size };
	piece.pivot.copy( pivot );
	piece.mesh.geometry.dispose();
	piece.mesh.geometry = buildGeometry( TYPES[ old.type ], piece.size );

	if ( spin !== 0 ) setSpin( piece, spin );

	return piece;

}

function duplicateSelected() {

	if ( selected === null ) return;

	const source = collectSubtree( selected ); // parents always precede children
	const cloneOf = new Map();

	if ( selected.parent === null ) {

		// duplicating the root copies the whole toy into a new slot

		const original = selected;
		addToy();

		for ( const old of source ) {

			const placement = {
				position: old.position.clone(),
				quaternion: old.quaternion.clone(),
				normal: old.attachNormal.clone()
			};

			cloneOf.set( old, clonePiece( old, cloneOf.get( old.parent ) ?? null, placement, old.spin, old.pivot ) );

		}

		select( cloneOf.get( original ) );

	} else {

		// duplicating a branch mirrors it onto the opposite side of the parent

		const n = selected.attachNormal;
		const center = selected.parent.position;

		for ( const old of source ) {

			const def = TYPES[ old.type ];

			const normal = old.attachNormal.clone().addScaledVector( n, - 2 * old.attachNormal.dot( n ) );
			normal.set( Math.round( normal.x ), Math.round( normal.y ), Math.round( normal.z ) );

			const position = old.position.clone();
			position.addScaledVector( n, - 2 * _v1.copy( old.position ).sub( center ).dot( n ) );

			const quaternion = new THREE.Quaternion().setFromUnitVectors( def.mountAxis, normal );

			// a mirrored motor turns the other way when its axis lies on the mirror normal

			const worldAxis = def.mountAxis.clone().applyQuaternion( old.quaternion );
			const spin = Math.abs( worldAxis.dot( n ) ) > 0.5 ? - old.spin : old.spin;

			// carry the pivot offset through the reflection

			const pivot = old.pivot.clone().applyQuaternion( old.quaternion );
			pivot.addScaledVector( n, - 2 * pivot.dot( n ) );
			pivot.applyQuaternion( _q1.copy( quaternion ).invert() );

			const placement = { position, quaternion, normal };

			cloneOf.set( old, clonePiece( old, cloneOf.get( old.parent ) ?? selected.parent, placement, spin, pivot ) );

		}

		select( cloneOf.get( selected ) );

	}

	saveLocal();

}

function deleteSelected() {

	if ( selected === null ) return;

	const doomed = new Set( collectSubtree( selected ) );

	for ( const piece of doomed ) destroyPiece( piece );

	activeToy.pieces = activeToy.pieces.filter( ( piece ) => ! doomed.has( piece ) );

	select( null );
	updateToysList();
	saveLocal();
	updateHint();

}

// resize handles

function resizeKindFor( type, dirLocal ) {

	if ( type === 'ball' ) return 'radius';
	if ( type === 'wheel' ) return Math.abs( dirLocal.z ) > 0.5 ? 'width' : 'radius';

	return Math.abs( dirLocal.x ) > 0.5 ? 'x' : Math.abs( dirLocal.y ) > 0.5 ? 'y' : 'z';

}

function handleOffsetFor( piece, dirLocal ) {

	const kind = resizeKindFor( piece.type, dirLocal );
	const margin = 0.11;

	if ( kind === 'radius' ) return piece.size.radius + margin;
	if ( kind === 'width' ) return piece.size.width / 2 + margin;

	return piece.size[ kind ] / 2 + margin;

}

function createHandles( piece ) {

	for ( const dir of HANDLE_DIRS ) {

		const handle = new THREE.Mesh( handleGeometry, handleMaterial );
		handle.quaternion.setFromUnitVectors( Y_AXIS, dir );
		handle.position.copy( dir ).multiplyScalar( handleOffsetFor( piece, dir ) );
		handle.scale.setScalar( GIZMO_SCALE );
		handle.renderOrder = 10;
		handle.userData.dir = dir;
		piece.mesh.add( handle );
		handles.push( handle );

	}

}

function removeHandles() {

	for ( const handle of handles ) handle.removeFromParent();

	handles = [];
	renderer.domElement.style.cursor = '';

}

function updateHandlePositions() {

	if ( selected === null ) return;

	for ( const handle of handles ) {

		const dir = handle.userData.dir;
		handle.position.copy( dir ).multiplyScalar( handleOffsetFor( selected, dir ) );

	}

}

function lineParameterAtRay( origin, dir, ray ) {

	// parameter along the line origin + t * dir closest to the ray

	_v1.copy( origin ).sub( ray.origin );

	const b = dir.dot( ray.direction );
	const denom = 1 - b * b;

	if ( Math.abs( denom ) < 1e-4 ) return null;

	return ( b * ray.direction.dot( _v1 ) - dir.dot( _v1 ) ) / denom;

}

function clampResizeDelta( piece, kind, delta ) {

	const size0 = resize.size0;

	if ( kind === 'radius' ) {

		const max = piece.type === 'wheel' ? 1.0 : 0.9;
		return THREE.MathUtils.clamp( delta, 0.08 - size0.radius, max - size0.radius );

	}

	if ( kind === 'width' ) return THREE.MathUtils.clamp( delta, 0.06 - size0.width, 0.9 - size0.width );

	return THREE.MathUtils.clamp( delta, 0.1 - size0[ kind ], 2.5 - size0[ kind ] );

}

function onResizeStart( event ) {

	if ( mode !== 'build' || selected === null || drag !== null || resize !== null || pivotDrag !== null || moveDrag !== null || handles.length === 0 ) return;

	setRayFromEvent( event );
	const hits = raycaster.intersectObjects( handles, false );
	if ( hits.length === 0 ) return;

	event.stopPropagation(); // keep OrbitControls and click-select out of it

	const piece = selected;
	const dirLocal = hits[ 0 ].object.userData.dir;
	const dirWorld = dirLocal.clone().applyQuaternion( piece.quaternion );
	const lineOrigin = hits[ 0 ].object.getWorldPosition( new THREE.Vector3() );

	const t0 = lineParameterAtRay( lineOrigin, dirWorld, raycaster.ray );
	if ( t0 === null ) return;

	const kind = resizeKindFor( piece.type, dirLocal );

	// children attached to a moving face ride along with it

	const moved = [];
	const axisWorld = piece.type === 'wheel' ? Z_AXIS.clone().applyQuaternion( piece.quaternion ) : null;

	for ( const child of activeToy.pieces ) {

		if ( child.parent !== piece ) continue;

		let shiftDir = null;

		if ( kind === 'x' || kind === 'y' || kind === 'z' || kind === 'width' ) {

			if ( child.attachNormal.dot( dirWorld ) > 0.9 ) shiftDir = dirWorld;

		} else if ( piece.type === 'ball' ) {

			shiftDir = child.attachNormal;

		} else if ( Math.abs( child.attachNormal.dot( axisWorld ) ) < 0.5 ) {

			shiftDir = child.attachNormal;

		}

		if ( shiftDir !== null ) {

			for ( const member of collectSubtree( child ) ) {

				moved.push( { piece: member, pos0: member.position.clone(), shiftDir } );

			}

		}

	}

	resize = {
		piece, kind, dirWorld, lineOrigin, t0, moved,
		size0: { ...piece.size },
		pos0: piece.position.clone(),
		lastD: 0
	};

	document.body.style.cursor = 'grabbing';

	window.addEventListener( 'pointermove', onResizeMove, true );
	window.addEventListener( 'pointerup', onResizeEnd, true );
	window.addEventListener( 'pointercancel', onResizeEnd, true );

}

function onResizeMove( event ) {

	setRayFromEvent( event );

	const t = lineParameterAtRay( resize.lineOrigin, resize.dirWorld, raycaster.ray );
	if ( t === null ) return;

	let delta = Math.round( ( t - resize.t0 ) / SIZE_SNAP ) * SIZE_SNAP;
	delta = clampResizeDelta( resize.piece, resize.kind, delta );

	if ( delta === resize.lastD ) return;
	resize.lastD = delta;

	applyResize( delta );

}

function applyResize( delta ) {

	const { piece, kind, dirWorld, size0, pos0, moved } = resize;

	if ( kind === 'radius' ) {

		piece.size.radius = size0.radius + delta;

	} else {

		// one face moves, the opposite face stays put

		if ( kind === 'width' ) piece.size.width = size0.width + delta;
		else piece.size[ kind ] = size0[ kind ] + delta;

		piece.position.copy( pos0 ).addScaledVector( dirWorld, delta / 2 );
		piece.mesh.position.copy( piece.position );

	}

	const old = piece.mesh.geometry;
	piece.mesh.geometry = buildGeometry( TYPES[ piece.type ], piece.size );
	old.dispose();

	for ( const entry of moved ) {

		entry.piece.position.copy( entry.pos0 ).addScaledVector( entry.shiftDir, delta );
		entry.piece.mesh.position.copy( entry.piece.position );

	}

	updateHandlePositions();
	if ( piece.indicator !== null ) setSpin( piece, piece.spin );

}

function onResizeEnd( event ) {

	event.stopPropagation();
	cancelResize();

}

// spin pivot pin

function onPivotStart( event ) {

	if ( mode !== 'build' || selected === null || selected.indicator === null ) return;
	if ( drag !== null || resize !== null || pivotDrag !== null || moveDrag !== null ) return;

	setRayFromEvent( event );
	if ( raycaster.intersectObject( selected.indicator.marker, false ).length === 0 ) return;

	event.stopPropagation();

	const piece = selected;
	const axisWorld = TYPES[ piece.type ].mountAxis.clone().applyQuaternion( piece.quaternion );

	pivotDrag = {
		piece,
		plane: new THREE.Plane().setFromNormalAndCoplanarPoint( axisWorld, piece.position )
	};

	document.body.style.cursor = 'grabbing';

	window.addEventListener( 'pointermove', onPivotMove, true );
	window.addEventListener( 'pointerup', onPivotEnd, true );
	window.addEventListener( 'pointercancel', onPivotEnd, true );

}

function onPivotMove( event ) {

	setRayFromEvent( event );

	if ( raycaster.ray.intersectPlane( pivotDrag.plane, _v1 ) === null ) return;

	const piece = pivotDrag.piece;
	const mountAxis = TYPES[ piece.type ].mountAxis;

	// world hit → local offset from the piece centre, kept ⊥ to the spin axis

	_v1.sub( piece.position ).applyQuaternion( _q1.copy( piece.quaternion ).invert() );
	_v1.addScaledVector( mountAxis, - _v1.dot( mountAxis ) );

	if ( _v1.length() > 1.5 ) _v1.setLength( 1.5 );

	_v1.set(
		Math.round( _v1.x / SIZE_SNAP ) * SIZE_SNAP,
		Math.round( _v1.y / SIZE_SNAP ) * SIZE_SNAP,
		Math.round( _v1.z / SIZE_SNAP ) * SIZE_SNAP
	);

	if ( _v1.equals( piece.pivot ) ) return;

	piece.pivot.copy( _v1 );
	setSpin( piece, piece.spin ); // rebuild the indicator around the new axis

}

function onPivotEnd( event ) {

	event.stopPropagation();
	cancelPivotDrag();

}

function cancelPivotDrag() {

	if ( pivotDrag === null ) return;

	window.removeEventListener( 'pointermove', onPivotMove, true );
	window.removeEventListener( 'pointerup', onPivotEnd, true );
	window.removeEventListener( 'pointercancel', onPivotEnd, true );

	pivotDrag = null;
	document.body.style.cursor = '';

}

// moving pieces — drag a piece to re-attach it (or the root to move the toy)

function onMoveStart( event ) {

	if ( mode !== 'build' || drag !== null || resize !== null || pivotDrag !== null || moveDrag !== null ) return;
	if ( event.button !== 0 ) return; // right-drag on a piece still pans

	setRayFromEvent( event );
	const hits = raycaster.intersectObjects( activeToy.pieces.map( ( p ) => p.mesh ), false );
	if ( hits.length === 0 ) return;

	event.stopPropagation();

	const piece = hits[ 0 ].object.userData.piece;

	moveDrag = {
		piece,
		startX: event.clientX,
		startY: event.clientY,
		active: false, // a drag below the click threshold is just a select
		grabOffset: hits[ 0 ].point.clone().sub( piece.position ).applyQuaternion( _q1.copy( piece.quaternion ).invert() ),
		subtree: collectSubtree( piece ).map( ( p ) => ( { piece: p, pos0: p.position.clone(), quat0: p.quaternion.clone() } ) ),
		placement: null,
		parent: null
	};

	window.addEventListener( 'pointermove', onMoveMove, true );
	window.addEventListener( 'pointerup', onMoveEnd, true );
	window.addEventListener( 'pointercancel', onMoveCancel, true );

}

function onMoveCancel() {

	cancelMoveDrag();

}

function moveTransform( entry, placement ) {

	// subtree rides along: rotate about the moved piece's centre, then translate

	const rootStart = moveDrag.subtree[ 0 ];
	_q2.copy( placement.quaternion ).multiply( _q1.copy( rootStart.quat0 ).invert() );

	const mesh = entry.piece.mesh;
	mesh.quaternion.copy( _q2 ).multiply( entry.quat0 );
	mesh.position.copy( entry.pos0 ).sub( rootStart.pos0 ).applyQuaternion( _q2 ).add( placement.position );

}

function onMoveMove( event ) {

	if ( moveDrag.active === false ) {

		if ( Math.hypot( event.clientX - moveDrag.startX, event.clientY - moveDrag.startY ) < 6 ) return;

		moveDrag.active = true;
		select( null );
		document.body.style.cursor = 'grabbing';

	}

	setRayFromEvent( event );

	const piece = moveDrag.piece;
	const subtreeSet = new Set( moveDrag.subtree.map( ( entry ) => entry.piece ) );

	moveDrag.placement = null;
	moveDrag.parent = null;

	const def = TYPES[ piece.type ];

	if ( piece.parent !== null ) {

		// a child re-attaches to any piece outside its own subtree

		const targets = activeToy.pieces.filter( ( p ) => ! subtreeSet.has( p ) ).map( ( p ) => p.mesh );
		const hits = raycaster.intersectObjects( targets, false );

		if ( hits.length > 0 ) {

			const hit = hits[ 0 ];
			const normal = hit.face.normal.clone().transformDirection( hit.object.matrixWorld );
			const n = snapToAxis( normal ).clone();

			// keep the grab point under the cursor: subtract the grab offset's
			// component in the target face plane

			_q1.setFromUnitVectors( def.mountAxis, n );
			_v1.copy( moveDrag.grabOffset ).applyQuaternion( _q1 );
			_v1.addScaledVector( n, - _v1.dot( n ) );

			moveDrag.placement = computePlacement( def, hit.point.clone().sub( _v1 ), n, mountDepthFor( piece ) );
			moveDrag.parent = hit.object.userData.piece;

		}

	} else if ( raycaster.ray.intersectPlane( groundPlane, _v1 ) !== null ) {

		// the root slides across the floor, taking the whole toy with it

		_q1.setFromUnitVectors( def.mountAxis, Y_AXIS );
		_v2.copy( moveDrag.grabOffset ).applyQuaternion( _q1 );
		_v2.y = 0;

		moveDrag.placement = computePlacement( def, _v1.sub( _v2 ), Y_AXIS, mountDepthFor( piece ) );

	}

	if ( moveDrag.placement !== null ) {

		for ( const entry of moveDrag.subtree ) moveTransform( entry, moveDrag.placement );

	}

}

function onMoveEnd( event ) {

	event.stopPropagation();

	window.removeEventListener( 'pointermove', onMoveMove, true );
	window.removeEventListener( 'pointerup', onMoveEnd, true );
	window.removeEventListener( 'pointercancel', onMoveCancel, true );

	const { piece, subtree, placement, parent, active } = moveDrag;
	moveDrag = null;
	document.body.style.cursor = '';

	if ( active === false ) {

		select( piece );
		return;

	}

	if ( placement !== null ) {

		// commit: meshes are already in place, write it into the pieces

		_q2.copy( placement.quaternion ).multiply( _q1.copy( subtree[ 0 ].quat0 ).invert() );

		for ( const entry of subtree ) {

			entry.piece.position.copy( entry.piece.mesh.position );
			entry.piece.quaternion.copy( entry.piece.mesh.quaternion );

			if ( entry.piece !== piece ) {

				entry.piece.attachNormal.copy( snapToAxis( _v1.copy( entry.piece.attachNormal ).applyQuaternion( _q2 ) ) );

			}

		}

		piece.attachNormal.copy( placement.normal );
		if ( parent !== null ) piece.parent = parent;

		saveLocal();

	} else {

		for ( const entry of subtree ) {

			entry.piece.mesh.position.copy( entry.pos0 );
			entry.piece.mesh.quaternion.copy( entry.quat0 );

		}

	}

	select( piece );

}

function cancelMoveDrag() {

	if ( moveDrag === null ) return;

	window.removeEventListener( 'pointermove', onMoveMove, true );
	window.removeEventListener( 'pointerup', onMoveEnd, true );
	window.removeEventListener( 'pointercancel', onMoveCancel, true );

	if ( moveDrag.active ) {

		for ( const entry of moveDrag.subtree ) {

			entry.piece.mesh.position.copy( entry.pos0 );
			entry.piece.mesh.quaternion.copy( entry.quat0 );

		}

	}

	moveDrag = null;
	document.body.style.cursor = '';

}

function cancelResize() {

	if ( resize === null ) return;

	window.removeEventListener( 'pointermove', onResizeMove, true );
	window.removeEventListener( 'pointerup', onResizeEnd, true );
	window.removeEventListener( 'pointercancel', onResizeEnd, true );

	resize = null;
	document.body.style.cursor = '';

	saveLocal();

}

// audio — synthesised wood knocks for contact hits

function initAudio() {

	if ( audio !== null ) {

		if ( audio.ctx.state === 'suspended' ) audio.ctx.resume();
		return;

	}

	const ctx = new AudioContext();

	// a compressor keeps pile-ups from clipping into crackle

	const compressor = ctx.createDynamicsCompressor();
	compressor.threshold.value = - 18;
	compressor.ratio.value = 4;
	compressor.attack.value = 0.002;
	compressor.release.value = 0.15;
	compressor.connect( ctx.destination );

	const master = ctx.createGain();
	master.gain.value = 0.6;
	master.connect( compressor );

	const noise = ctx.createBuffer( 1, ctx.sampleRate * 0.05, ctx.sampleRate );
	const data = noise.getChannelData( 0 );
	for ( let i = 0; i < data.length; i ++ ) data[ i ] = Math.random() * 2 - 1;

	audio = { ctx, master, noise };

}

// inharmonic mode ratios of a struck wooden bar, and their relative weights

const KNOCK_RATIOS = [ 1, 2.42, 3.83, 5.11 ];
const KNOCK_GAINS = [ 1, 0.45, 0.24, 0.12 ];

function playKnock( point, speed ) {

	if ( audio === null || audio.ctx.state !== 'running' ) return;

	const ctx = audio.ctx;
	const time = ctx.currentTime;

	const strength = Math.min( speed / 6, 1 ) ** 2;
	const frequency = 160 + Math.random() * 180; // every knock its own tone

	// pan by where the hit sits on screen

	const pan = ctx.createStereoPanner();
	_v1.set( point.x, point.y, point.z ).project( camera );
	pan.pan.value = THREE.MathUtils.clamp( _v1.x, - 0.8, 0.8 );
	pan.connect( audio.master );

	// modal ring: inharmonic partials, each dying at its own rate,
	// the higher ones only waking up on harder hits

	for ( let i = 0; i < KNOCK_RATIOS.length; i ++ ) {

		const brightness = i === 0 ? 1 : 0.35 + 0.65 * strength;
		const amplitude = 0.55 * strength * KNOCK_GAINS[ i ] * brightness;
		const decay = 0.07 * ( 1 + strength * 0.6 ) / ( 1 + i * 0.8 );

		const gain = ctx.createGain();
		gain.gain.setValueAtTime( amplitude, time );
		gain.gain.exponentialRampToValueAtTime( 0.001, time + decay );
		gain.connect( pan );

		const osc = ctx.createOscillator();
		osc.frequency.value = frequency * KNOCK_RATIOS[ i ] * ( 0.98 + Math.random() * 0.04 );
		osc.connect( gain );
		osc.start( time );
		osc.stop( time + decay + 0.02 );

	}

	// low thump: the dull body of the impact

	const thumpGain = ctx.createGain();
	thumpGain.gain.setValueAtTime( 0.5 * strength, time );
	thumpGain.gain.exponentialRampToValueAtTime( 0.001, time + 0.035 );

	const thumpFilter = ctx.createBiquadFilter();
	thumpFilter.type = 'lowpass';
	thumpFilter.frequency.value = 500 + 500 * strength;

	const thump = ctx.createBufferSource();
	thump.buffer = audio.noise;
	thump.connect( thumpFilter ).connect( thumpGain ).connect( pan );
	thump.start( time );

	// attack tick: a pinch of band-passed noise, brighter when harder

	const tickGain = ctx.createGain();
	tickGain.gain.setValueAtTime( 0.3 * strength * ( 0.4 + 0.6 * strength ), time );
	tickGain.gain.exponentialRampToValueAtTime( 0.001, time + 0.018 );

	const tickFilter = ctx.createBiquadFilter();
	tickFilter.type = 'bandpass';
	tickFilter.frequency.value = frequency * 7;

	const tick = ctx.createBufferSource();
	tick.buffer = audio.noise;
	tick.connect( tickFilter ).connect( tickGain ).connect( pan );
	tick.start( time );

}

// play mode

function setMode( next ) {

	if ( next === mode ) return;

	cancelResize();
	cancelPivotDrag();
	cancelMoveDrag();
	abortRecording();

	if ( next === 'play' ) {

		select( null );
		initAudio(); // mode switches are user gestures, so this is allowed
		enterPlay();

	} else {

		exitPlay();

	}

	mode = next;
	focusToy = null;

	document.body.classList.toggle( 'play', mode === 'play' );
	document.getElementById( 'buildBtn' ).classList.toggle( 'active', mode === 'build' );
	document.getElementById( 'playBtn' ).classList.toggle( 'active', mode === 'play' );

	refreshVisibility();
	updateToysList();

	for ( const piece of allPieces() ) {

		if ( piece.indicator !== null ) piece.indicator.root.visible = mode === 'build';

	}

	updateToolbar();
	updateHint();

}

function colliderLocalPoints( piece ) {

	const kind = TYPES[ piece.type ].kind;
	const points = [];

	if ( kind === 'box' ) {

		const hx = piece.size.x / 2, hy = piece.size.y / 2, hz = piece.size.z / 2;

		for ( const sx of [ - 1, 1 ] )
			for ( const sy of [ - 1, 1 ] )
				for ( const sz of [ - 1, 1 ] )
					points.push( new THREE.Vector3( sx * hx, sy * hy, sz * hz ) );

	} else if ( kind === 'cylinder' ) {

		const radius = piece.size.radius, halfWidth = piece.size.width / 2;

		for ( let i = 0; i < 16; i ++ ) {

			const angle = ( i / 16 ) * Math.PI * 2;
			const x = Math.cos( angle ) * radius;
			const y = Math.sin( angle ) * radius;
			points.push( new THREE.Vector3( x, y, - halfWidth ), new THREE.Vector3( x, y, halfWidth ) );

		}

	}

	return points;

}

function pieceMinY( piece ) {

	if ( TYPES[ piece.type ].kind === 'sphere' ) return piece.position.y - piece.size.radius;

	let minY = Infinity;

	for ( const point of colliderLocalPoints( piece ) ) {

		_v1.copy( point ).applyQuaternion( piece.quaternion ).add( piece.position );
		minY = Math.min( minY, _v1.y );

	}

	return minY;

}

function toyBoundsXZ( toy ) {

	let minX = Infinity, maxX = - Infinity, minZ = Infinity, maxZ = - Infinity;

	for ( const piece of toy.pieces ) {

		if ( TYPES[ piece.type ].kind === 'sphere' ) {

			const r = piece.size.radius;
			minX = Math.min( minX, piece.position.x - r );
			maxX = Math.max( maxX, piece.position.x + r );
			minZ = Math.min( minZ, piece.position.z - r );
			maxZ = Math.max( maxZ, piece.position.z + r );

		} else {

			for ( const point of colliderLocalPoints( piece ) ) {

				_v1.copy( point ).applyQuaternion( piece.quaternion ).add( piece.position );
				minX = Math.min( minX, _v1.x );
				maxX = Math.max( maxX, _v1.x );
				minZ = Math.min( minZ, _v1.z );
				maxZ = Math.max( maxZ, _v1.z );

			}

		}

	}

	return { minX, maxX, minZ, maxZ };

}

function addCollider( body, piece, origin, lift, offset ) {

	const def = TYPES[ piece.type ];

	const shapeDef = b3.b3DefaultShapeDef();
	shapeDef.density = DENSITY;
	shapeDef.enableHitEvents = true;
	shapeDef.baseMaterial.friction = def.friction;
	shapeDef.baseMaterial.restitution = def.restitution;

	if ( def.kind === 'sphere' ) {

		b3.b3CreateSphereShape( body, shapeDef, {
			center: {
				x: piece.position.x + offset.x - origin.x,
				y: piece.position.y + lift - origin.y,
				z: piece.position.z + offset.z - origin.z
			},
			radius: piece.size.radius
		} );

		return;

	}

	const flat = [];

	for ( const point of colliderLocalPoints( piece ) ) {

		_v1.copy( point ).applyQuaternion( piece.quaternion ).add( piece.position );
		flat.push( _v1.x + offset.x - origin.x, _v1.y + lift - origin.y, _v1.z + offset.z - origin.z );

	}

	const hull = b3.b3CreateHull( flat );
	b3.b3CreateHullShape( body, shapeDef, hull );
	hull.delete();

}

function spinRootOf( piece ) {

	let p = piece;

	while ( p !== null ) {

		if ( p.spin !== 0 ) return p;
		p = p.parent;

	}

	return null;

}

function toyRootOf( piece ) {

	let p = piece;

	while ( p.parent !== null ) p = p.parent;

	return p;

}

function enterPlay() {

	const worldDef = b3.b3DefaultWorldDef();
	worldDef.gravity = { x: 0, y: - 9.81, z: 0 };
	worldDef.hitEventThreshold = 0.6; // m/s of approach before a knock
	const world = b3.b3CreateWorld( worldDef );

	const groundDef = b3.b3DefaultBodyDef();
	groundDef.position = { x: 0, y: - 0.51, z: 0 };
	const groundBody = b3.b3CreateBody( world, groundDef );
	const groundShape = b3.b3DefaultShapeDef();
	groundShape.enableHitEvents = true;
	groundShape.baseMaterial.friction = 0.9;
	b3.b3CreateBoxShape( groundBody, groundShape, 60, 0.5, 60 ); // safety net under the cup

	const cupDef = b3.b3DefaultBodyDef();
	const cupBody = b3.b3CreateBody( world, cupDef );
	b3.b3CreateMeshShape( cupBody, groundShape, groundMesh, { x: 1, y: 1, z: 1 } );

	const played = toys.filter( ( toy ) => toy.pieces.length > 0 && toy.visible );

	// several toys play side by side; a single toy stays where it was built

	const offsets = new Map();

	if ( played.length > 1 ) {

		const bounds = played.map( ( toy ) => toyBoundsXZ( toy ) );

		let total = TOY_GAP * ( played.length - 1 );
		for ( const b of bounds ) total += b.maxX - b.minX;

		let cursor = - total / 2;

		played.forEach( ( toy, i ) => {

			const b = bounds[ i ];
			const width = b.maxX - b.minX;
			offsets.set( toy, new THREE.Vector3( cursor + width / 2 - ( b.minX + b.maxX ) / 2, 0, - ( b.minZ + b.maxZ ) / 2 ) );
			cursor += width + TOY_GAP;

		} );

	} else if ( played.length === 1 ) {

		offsets.set( played[ 0 ], new THREE.Vector3() );

	}

	// drop the toys from a touch above the floor

	let minY = Infinity;
	for ( const toy of played ) for ( const piece of toy.pieces ) minY = Math.min( minY, pieceMinY( piece ) );
	const lift = played.length > 0 ? 0.02 - Math.min( minY, 0.02 ) : 0;

	// each toy's rigid assembly becomes one body; every spinning piece (plus
	// anything built onto it) becomes its own body, joined by a motorised hinge

	const groups = new Map();

	for ( const toy of played ) {

		for ( const piece of toy.pieces ) {

			const key = spinRootOf( piece ) ?? toyRootOf( piece );
			if ( ! groups.has( key ) ) groups.set( key, { toy, members: [] } );
			groups.get( key ).members.push( piece );

		}

	}

	const bindings = [];
	const bodies = new Map();
	const toyBodies = new Map();

	for ( const [ key, group ] of groups ) {

		const offset = offsets.get( group.toy );
		const origin = new THREE.Vector3();

		if ( key.spin !== 0 ) {

			origin.copy( key.position );

		} else {

			for ( const member of group.members ) origin.add( member.position );
			origin.divideScalar( group.members.length );

		}

		origin.add( offset );
		origin.y += lift;

		const bodyDef = b3.b3DefaultBodyDef();
		bodyDef.type = b3.b3BodyType.b3_dynamicBody;
		bodyDef.position = { x: origin.x, y: origin.y, z: origin.z };
		const body = b3.b3CreateBody( world, bodyDef );

		const rec = { body, origin };
		bodies.set( key, rec );

		if ( ! toyBodies.has( group.toy ) ) toyBodies.set( group.toy, [] );
		toyBodies.get( group.toy ).push( rec );

		for ( const piece of group.members ) {

			addCollider( body, piece, origin, lift, offset );

			const localPos = piece.position.clone().add( offset );
			localPos.y += lift;
			localPos.sub( origin );

			bindings.push( { piece, rec, localPos, localQuat: piece.quaternion.clone() } );

		}

	}

	for ( const [ key, rec ] of bodies ) {

		if ( key.spin === 0 ) continue;

		const def = TYPES[ key.type ];
		const axis = def.mountAxis.clone().applyQuaternion( key.quaternion );

		if ( key.parent === null ) {

			// a lone spinner has nothing to push against — freewheel

			b3.b3Body_SetAngularVelocity( rec.body, {
				x: axis.x * SPIN_SPEED * key.spin,
				y: axis.y * SPIN_SPEED * key.spin,
				z: axis.z * SPIN_SPEED * key.spin
			} );

			continue;

		}

		const parentRec = bodies.get( spinRootOf( key.parent ) ?? toyRootOf( key.parent ) );

		_q1.setFromUnitVectors( Z_AXIS, axis );
		const frameQ = { v: { x: _q1.x, y: _q1.y, z: _q1.z }, s: _q1.w };

		// the hinge anchors at the piece centre plus its pivot offset

		const pivotWorld = key.pivot.clone().applyQuaternion( key.quaternion );

		const jointDef = b3.b3DefaultRevoluteJointDef();
		jointDef.base.bodyIdA = parentRec.body;
		jointDef.base.bodyIdB = rec.body;
		jointDef.base.localFrameA = {
			p: {
				x: rec.origin.x + pivotWorld.x - parentRec.origin.x,
				y: rec.origin.y + pivotWorld.y - parentRec.origin.y,
				z: rec.origin.z + pivotWorld.z - parentRec.origin.z
			},
			q: frameQ
		};
		jointDef.base.localFrameB = { p: { x: pivotWorld.x, y: pivotWorld.y, z: pivotWorld.z }, q: frameQ };
		jointDef.enableMotor = true;
		jointDef.motorSpeed = SPIN_SPEED * key.spin;
		jointDef.maxMotorTorque = MOTOR_TORQUE;
		b3.b3CreateRevoluteJoint( world, jointDef );

	}

	physics = { world, bindings, bodyList: [ ...bodies.values() ], toyBodies };
	physicsAcc = 0;

}

function resetPlay() {

	if ( physics === null ) return;

	b3.b3DestroyWorld( physics.world );
	physics = null;

	enterPlay();

}

function exitPlay() {

	if ( physics === null ) return;

	b3.b3DestroyWorld( physics.world );
	physics = null;

	for ( const piece of allPieces() ) {

		piece.mesh.position.copy( piece.position );
		piece.mesh.quaternion.copy( piece.quaternion );

	}

	controls.target.set( 0, 0.4, 0 );

}

function animate() {

	const delta = Math.min( clock.getDelta(), 0.1 );

	if ( physics !== null ) {

		physicsAcc += delta;

		while ( physicsAcc >= TIME_STEP ) {

			b3.b3World_Step( physics.world, TIME_STEP, 4 );
			physicsAcc -= TIME_STEP;

			b3.getEvents( eventsBuffer, physics.world );

			const knocks = Math.min( b3.getNumContactHitEvents( eventsBuffer ), 4 );

			for ( let i = 0; i < knocks; i ++ ) {

				b3.getContactHitEventAt( hitEvent, eventsBuffer, i );
				playKnock( hitEvent.point, hitEvent.approachSpeed );

			}

		}

		for ( const binding of physics.bindings ) {

			const p = b3.b3Body_GetPosition( binding.rec.body );
			const q = b3.b3Body_GetRotation( binding.rec.body );

			_q1.set( q.v.x, q.v.y, q.v.z, q.s );

			const mesh = binding.piece.mesh;
			mesh.quaternion.copy( _q1 ).multiply( binding.localQuat );
			mesh.position.copy( binding.localPos ).applyQuaternion( _q1 ).add( _v1.set( p.x, p.y, p.z ) );

		}

		const followed = focusToy !== null && physics.toyBodies.has( focusToy )
			? physics.toyBodies.get( focusToy )
			: physics.bodyList;

		if ( followed.length > 0 ) {

			// keep the camera on the centre of action

			_v2.set( 0, 0, 0 );

			for ( const rec of followed ) {

				const p = b3.b3Body_GetPosition( rec.body );
				_v2.x += p.x; _v2.y += p.y; _v2.z += p.z;

			}

			_v2.divideScalar( followed.length );
			_v2.y = Math.max( _v2.y, 0.3 );
			controls.target.lerp( _v2, 0.05 );

		}

	} else if ( activeToy !== null ) {

		for ( const piece of activeToy.pieces ) {

			if ( piece.indicator !== null ) piece.indicator.pivot.rotation.z += piece.spin * 3.5 * delta;

		}

	}

	controls.update();
	postProcessing.render();

	if ( recording !== null && recording.finishing === false ) captureFrame();

}
