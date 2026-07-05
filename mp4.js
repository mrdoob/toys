// Simple MP4 muxer for H.264 encoded chunks — from the three.js editor

export function createMP4( chunks, avcC, width, height, fps ) {

	const timescale = 90000;
	const frameDuration = timescale / fps;

	function u32( value ) {

		return new Uint8Array( [ ( value >> 24 ) & 0xFF, ( value >> 16 ) & 0xFF, ( value >> 8 ) & 0xFF, value & 0xFF ] );

	}

	function u16( value ) {

		return new Uint8Array( [ ( value >> 8 ) & 0xFF, value & 0xFF ] );

	}

	function str( s ) {

		return new TextEncoder().encode( s );

	}

	function concat( ...arrays ) {

		const totalLength = arrays.reduce( ( sum, arr ) => sum + arr.length, 0 );
		const result = new Uint8Array( totalLength );
		let offset = 0;
		for ( const arr of arrays ) {

			result.set( arr, offset );
			offset += arr.length;

		}

		return result;

	}

	function box( type, ...contents ) {

		const data = concat( ...contents );
		const size = data.length + 8;
		return concat( u32( size ), str( type ), data );

	}

	function fullBox( type, version, flags, ...contents ) {

		return box( type, new Uint8Array( [ version, ( flags >> 16 ) & 0xFF, ( flags >> 8 ) & 0xFF, flags & 0xFF ] ), ...contents );

	}

	// ftyp
	const ftyp = box( 'ftyp',
		str( 'isom' ),
		u32( 512 ),
		str( 'isom' ), str( 'iso2' ), str( 'avc1' ), str( 'mp41' )
	);

	// Collect sample info
	const sampleSizes = [];
	const syncSamples = [];

	for ( let i = 0; i < chunks.length; i ++ ) {

		sampleSizes.push( chunks[ i ].data.length );
		if ( chunks[ i ].type === 'key' ) syncSamples.push( i + 1 );

	}

	// mdat
	let mdatSize = 8;
	for ( const chunk of chunks ) mdatSize += chunk.data.length;

	// stsd - Sample Description
	const avc1 = box( 'avc1',
		new Uint8Array( 6 ), // reserved
		u16( 1 ), // data reference index
		new Uint8Array( 16 ), // pre-defined + reserved
		u16( width ),
		u16( height ),
		u32( 0x00480000 ), // horizontal resolution 72 dpi
		u32( 0x00480000 ), // vertical resolution 72 dpi
		u32( 0 ), // reserved
		u16( 1 ), // frame count
		new Uint8Array( 32 ), // compressor name
		u16( 0x0018 ), // depth
		new Uint8Array( [ 0xFF, 0xFF ] ), // pre-defined
		box( 'avcC', avcC )
	);

	const stsd = fullBox( 'stsd', 0, 0, u32( 1 ), avc1 );

	// stts - Time-to-Sample
	const stts = fullBox( 'stts', 0, 0,
		u32( 1 ),
		u32( chunks.length ),
		u32( frameDuration )
	);

	// stsc - Sample-to-Chunk
	const stsc = fullBox( 'stsc', 0, 0,
		u32( 1 ),
		u32( 1 ), u32( chunks.length ), u32( 1 )
	);

	// stsz - Sample Sizes
	const stszData = [ u32( 0 ), u32( chunks.length ) ];
	for ( const size of sampleSizes ) stszData.push( u32( size ) );
	const stsz = fullBox( 'stsz', 0, 0, ...stszData );

	// stco - Chunk Offsets (placeholder, will be updated)
	const stco = fullBox( 'stco', 0, 0, u32( 1 ), u32( 0 ) );

	// stss - Sync Samples
	const stssData = [ u32( syncSamples.length ) ];
	for ( const sync of syncSamples ) stssData.push( u32( sync ) );
	const stss = fullBox( 'stss', 0, 0, ...stssData );

	// stbl
	const stbl = box( 'stbl', stsd, stts, stsc, stsz, stco, stss );

	// dinf
	const dref = fullBox( 'dref', 0, 0,
		u32( 1 ),
		fullBox( 'url ', 0, 1 )
	);
	const dinf = box( 'dinf', dref );

	// vmhd
	const vmhd = fullBox( 'vmhd', 0, 1, new Uint8Array( 8 ) );

	// minf
	const minf = box( 'minf', vmhd, dinf, stbl );

	// hdlr
	const hdlr = fullBox( 'hdlr', 0, 0,
		u32( 0 ), // pre-defined
		str( 'vide' ),
		new Uint8Array( 12 ), // reserved
		str( 'VideoHandler' ), new Uint8Array( 1 )
	);

	// mdhd
	const durationInTimescale = chunks.length * frameDuration;
	const mdhd = fullBox( 'mdhd', 0, 0,
		u32( 0 ), // creation time
		u32( 0 ), // modification time
		u32( timescale ),
		u32( durationInTimescale ),
		u16( 0x55C4 ), // language (und)
		u16( 0 ) // quality
	);

	// mdia
	const mdia = box( 'mdia', mdhd, hdlr, minf );

	// tkhd
	const tkhd = fullBox( 'tkhd', 0, 3,
		u32( 0 ), // creation time
		u32( 0 ), // modification time
		u32( 1 ), // track id
		u32( 0 ), // reserved
		u32( durationInTimescale ),
		new Uint8Array( 8 ), // reserved
		u16( 0 ), // layer
		u16( 0 ), // alternate group
		u16( 0 ), // volume
		u16( 0 ), // reserved
		// matrix
		u32( 0x00010000 ), u32( 0 ), u32( 0 ),
		u32( 0 ), u32( 0x00010000 ), u32( 0 ),
		u32( 0 ), u32( 0 ), u32( 0x40000000 ),
		u32( width << 16 ), // width (16.16 fixed point)
		u32( height << 16 ) // height (16.16 fixed point)
	);

	// trak
	const trak = box( 'trak', tkhd, mdia );

	// mvhd
	const mvhd = fullBox( 'mvhd', 0, 0,
		u32( 0 ), // creation time
		u32( 0 ), // modification time
		u32( timescale ),
		u32( durationInTimescale ),
		u32( 0x00010000 ), // rate (1.0)
		u16( 0x0100 ), // volume (1.0)
		new Uint8Array( 10 ), // reserved
		// matrix
		u32( 0x00010000 ), u32( 0 ), u32( 0 ),
		u32( 0 ), u32( 0x00010000 ), u32( 0 ),
		u32( 0 ), u32( 0 ), u32( 0x40000000 ),
		new Uint8Array( 24 ), // pre-defined
		u32( 2 ) // next track id
	);

	// moov
	const moov = box( 'moov', mvhd, trak );

	// Calculate actual mdat offset and update stco
	const mdatOffset = ftyp.length + moov.length;
	const moovArray = new Uint8Array( moov );
	// Find and update stco offset (search for 'stco' in moov)
	for ( let i = 0; i < moovArray.length - 16; i ++ ) {

		if ( moovArray[ i ] === 0x73 && moovArray[ i + 1 ] === 0x74 &&
			 moovArray[ i + 2 ] === 0x63 && moovArray[ i + 3 ] === 0x6F ) {

			// Found 'stco', offset value is at i + 12
			const offset = mdatOffset + 8;
			moovArray[ i + 12 ] = ( offset >> 24 ) & 0xFF;
			moovArray[ i + 13 ] = ( offset >> 16 ) & 0xFF;
			moovArray[ i + 14 ] = ( offset >> 8 ) & 0xFF;
			moovArray[ i + 15 ] = offset & 0xFF;
			break;

		}

	}

	// Update mdat size
	const mdatSizeBytes = u32( mdatSize );

	// Combine all parts
	const result = new Uint8Array( ftyp.length + moovArray.length + mdatSize );
	let offset = 0;
	result.set( ftyp, offset ); offset += ftyp.length;
	result.set( moovArray, offset ); offset += moovArray.length;
	result.set( mdatSizeBytes, offset );
	result.set( str( 'mdat' ), offset + 4 );
	offset += 8;

	for ( const chunk of chunks ) {

		result.set( chunk.data, offset );
		offset += chunk.data.length;

	}

	return result;

}
