import { sql, ensureTable, hasDatabase, validRobotData } from './_db.js';

export default async function handler( req, res ) {

	if ( ! hasDatabase() ) {

		res.status( 503 ).json( { error: 'no database configured' } );
		return;

	}

	await ensureTable();

	if ( req.method === 'GET' ) {

		const { mine, key, sort } = req.query;

		let rows;

		if ( mine !== undefined ) {

			if ( typeof key !== 'string' || key.length < 8 ) {

				res.status( 400 ).json( { error: 'missing key' } );
				return;

			}

			( { rows } = await sql`
				SELECT id, name, author, data, downloads, created_at
				FROM robots WHERE owner_key = ${ key }
				ORDER BY created_at DESC LIMIT 60
			` );

		} else if ( sort === 'new' ) {

			( { rows } = await sql`
				SELECT id, name, author, data, downloads, created_at
				FROM robots ORDER BY created_at DESC LIMIT 60
			` );

		} else {

			( { rows } = await sql`
				SELECT id, name, author, data, downloads, created_at
				FROM robots ORDER BY downloads DESC, created_at DESC LIMIT 60
			` );

		}

		res.status( 200 ).json( { robots: rows.map( ( row ) => ( {
			id: Number( row.id ),
			name: row.name,
			author: row.author,
			data: row.data,
			downloads: row.downloads,
			created: row.created_at
		} ) ) } );

		return;

	}

	if ( req.method === 'POST' ) {

		const body = req.body ?? {};
		const key = typeof body.key === 'string' ? body.key : '';
		const name = typeof body.name === 'string' ? body.name.trim().slice( 0, 40 ) : '';
		const author = typeof body.author === 'string' ? body.author.trim().slice( 0, 24 ) : '';

		if ( key.length < 8 || name === '' || ! validRobotData( body.data ) ) {

			res.status( 400 ).json( { error: 'invalid robot' } );
			return;

		}

		// a light lid on spam: one browser key can hold 50 published bots

		const { rows: countRows } = await sql`SELECT COUNT(*)::int AS count FROM robots WHERE owner_key = ${ key }`;

		if ( countRows[ 0 ].count >= 50 ) {

			res.status( 429 ).json( { error: 'publish limit reached — unpublish something first' } );
			return;

		}

		const { rows } = await sql`
			INSERT INTO robots (owner_key, name, author, data)
			VALUES (${ key }, ${ name }, ${ author }, ${ JSON.stringify( body.data ) }::jsonb)
			RETURNING id
		`;

		res.status( 201 ).json( { id: Number( rows[ 0 ].id ) } );
		return;

	}

	res.status( 405 ).json( { error: 'method not allowed' } );

}
