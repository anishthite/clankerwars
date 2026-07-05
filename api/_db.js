import { sql } from '@vercel/postgres';

let ready = null;

export function hasDatabase() {

	return Boolean( process.env.POSTGRES_URL );

}

export function ensureTable() {

	ready ??= sql`
		CREATE TABLE IF NOT EXISTS robots (
			id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
			owner_key TEXT NOT NULL,
			name TEXT NOT NULL,
			author TEXT NOT NULL DEFAULT '',
			data JSONB NOT NULL,
			downloads INT NOT NULL DEFAULT 0,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)
	`;

	return ready;

}

// a robot payload is { n: name, a: aiIndex, p: [pieceRow, ...] } — the same
// shape the client saves locally. keep it small and roughly well-formed.

export function validRobotData( data ) {

	if ( data === null || typeof data !== 'object' || Array.isArray( data ) ) return false;
	if ( ! Array.isArray( data.p ) || data.p.length === 0 || data.p.length > 150 ) return false;
	if ( ! data.p.every( ( row ) => Array.isArray( row ) && row.length <= 20 && row.every( ( v ) => typeof v === 'number' && Number.isFinite( v ) ) ) ) return false;
	if ( JSON.stringify( data ).length > 40000 ) return false;

	return true;

}

export { sql };
