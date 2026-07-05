import { sql, ensureTable, hasDatabase } from '../_db.js';

export default async function handler( req, res ) {

	if ( ! hasDatabase() ) {

		res.status( 503 ).json( { error: 'no database configured' } );
		return;

	}

	await ensureTable();

	const id = Number.parseInt( req.query.id, 10 );

	if ( ! Number.isInteger( id ) || id < 1 ) {

		res.status( 400 ).json( { error: 'bad id' } );
		return;

	}

	if ( req.method === 'GET' ) {

		// fetching by id is how imports arrive — ?dl=1 counts the download

		if ( req.query.dl !== undefined ) {

			await sql`UPDATE robots SET downloads = downloads + 1 WHERE id = ${ id }`;

		}

		const { rows } = await sql`
			SELECT id, name, author, data, downloads, created_at
			FROM robots WHERE id = ${ id }
		`;

		if ( rows.length === 0 ) {

			res.status( 404 ).json( { error: 'not found' } );
			return;

		}

		const row = rows[ 0 ];

		res.status( 200 ).json( { robot: {
			id: Number( row.id ),
			name: row.name,
			author: row.author,
			data: row.data,
			downloads: row.downloads,
			created: row.created_at
		} } );

		return;

	}

	if ( req.method === 'DELETE' ) {

		const key = typeof req.query.key === 'string' ? req.query.key : '';

		if ( key.length < 8 ) {

			res.status( 400 ).json( { error: 'missing key' } );
			return;

		}

		const { rowCount } = await sql`DELETE FROM robots WHERE id = ${ id } AND owner_key = ${ key }`;

		if ( rowCount === 0 ) {

			res.status( 404 ).json( { error: 'not found or not yours' } );
			return;

		}

		res.status( 200 ).json( { ok: true } );
		return;

	}

	res.status( 405 ).json( { error: 'method not allowed' } );

}
