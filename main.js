import * as THREE from 'three';
import { pass, mrt, normalView, builtinAOContext, screenUV } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { WoodNodeMaterial } from 'three/addons/materials/WoodNodeMaterial.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import Box3D from 'box3d.js/inline';
import { createMP4 } from './mp4.js';
import { makeSamples } from './samples.js';

const SPIN_SPEED = 13; // rad/s — a 1.7 m bar swings its tips at ~11 m/s
const MOTOR_TORQUE = 220;
const DENSITY = 100;
const GRID_SNAP = 0.1;
const SIZE_SNAP = 0.05;
const TIME_STEP = 1 / 60;
const STORAGE_KEY = 'rw-garage';
const REC_FPS = 60;
const REC_MAX_FRAMES = REC_FPS * 60; // record as long as you like, up to a minute

// battle tuning

const ARENA_APOTHEM = 6; // octagon wall distance from centre
const ARENA_OUT = 6.9; // beyond this you are out of the arena
const WALL_HEIGHT = 0.85;
const BATTLE_TIME = 90; // seconds until the judges decide
const COUNT_OUT = 12; // seconds of stillness before you are counted out
const KO_DAMAGE = 0.72; // fraction of total hp that ends a bot
const DRIVE = 12; // drive force per kg — the solver's static grip pins
// anything pushed with much less than its own weight, so thrust scales
// with mass and the weight penalty lives in the top-speed cap instead
const DMG_MIN_SPEED = 1.6; // m/s of approach before a hit hurts
const FIRE_DPS = 0.05; // fraction of a piece's max hp burned per second

const Y_AXIS = new THREE.Vector3( 0, 1, 0 );
const Z_AXIS = new THREE.Vector3( 0, 0, 1 );

// a tiny seeded rng — every battle replays the same from the same seed

function mulberry32( seed ) {

	let a = seed >>> 0;

	return function () {

		a |= 0; a = ( a + 0x6D2B79F5 ) | 0;
		let t = Math.imul( a ^ ( a >>> 15 ), 1 | a );
		t = ( t + Math.imul( t ^ ( t >>> 7 ), 61 | t ) ) ^ t;
		return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;

	};

}

// armour decides how heavy, how tough and how hard-hitting a piece is

const ARMORS = {
	wood: { name: 'Wood', density: 1.0, hp: 1.0, dmg: 1.0, flammable: true },
	steel: { name: 'Steel', density: 2.2, hp: 2.4, dmg: 1.35, flammable: false },
	titanium: { name: 'Titanium', density: 3.4, hp: 4.2, dmg: 1.6, flammable: false }
};

const ARMOR_KEYS = Object.keys( ARMORS );

const TYPES = {
	block: {
		name: 'Block',
		kind: 'box',
		defaultSize: { x: 0.5, y: 0.5, z: 0.5 },
		wood: [ 'maple', 'semigloss' ],
		mountAxis: Y_AXIS, mountDepth: 0.25,
		friction: 0.6, restitution: 0.05,
		hp: 110, dmg: 1.0, weapon: false, defaultArmor: 'wood',
		icon: '<rect x="10" y="10" width="28" height="28" rx="7"/>'
	},
	plank: {
		name: 'Plank',
		kind: 'box',
		defaultSize: { x: 1.2, y: 0.15, z: 0.45 },
		wood: [ 'teak', 'semigloss' ],
		mountAxis: Y_AXIS, mountDepth: 0.075,
		friction: 0.6, restitution: 0.05,
		hp: 70, dmg: 1.0, weapon: false, defaultArmor: 'wood',
		icon: '<rect x="4" y="18" width="40" height="12" rx="5"/>'
	},
	wheel: {
		name: 'Wheel',
		kind: 'cylinder',
		defaultSize: { radius: 0.24, width: 0.16 },
		wood: [ 'walnut', 'gloss' ],
		mountAxis: Z_AXIS, mountDepth: 0.08,
		friction: 1.0, restitution: 0.05,
		hp: 80, dmg: 0.8, weapon: false, defaultArmor: 'wood',
		icon: '<circle cx="24" cy="24" r="16"/><circle cx="24" cy="24" r="4" fill="#77502b"/>'
	},
	ball: {
		name: 'Ball',
		kind: 'sphere',
		defaultSize: { radius: 0.24 },
		wood: [ 'cherry', 'gloss' ],
		mountAxis: Y_AXIS, mountDepth: 0.24,
		friction: 0.45, restitution: 0.55, // slippery — balls work as casters
		hp: 90, dmg: 1.0, weapon: false, defaultArmor: 'wood',
		icon: '<circle cx="24" cy="24" r="15"/>'
	},
	wedge: {
		name: 'Wedge',
		kind: 'wedge',
		defaultSize: { x: 0.7, y: 0.35, z: 0.7 },
		wood: [ 'teak', 'semigloss' ],
		mountAxis: Y_AXIS, mountDepth: 0.175,
		friction: 0.35, restitution: 0.05,
		hp: 130, dmg: 1.3, weapon: false, defaultArmor: 'steel',
		icon: '<polygon points="8,36 40,36 8,12"/>'
	},
	bar: {
		name: 'Bar',
		kind: 'box',
		defaultSize: { x: 1.4, y: 0.12, z: 0.2 },
		wood: [ 'teak', 'semigloss' ],
		mountAxis: Y_AXIS, mountDepth: 0.06,
		friction: 0.5, restitution: 0.1,
		hp: 100, dmg: 2.6, weapon: true, defaultArmor: 'steel',
		icon: '<rect x="4" y="20" width="40" height="8" rx="3"/><circle cx="24" cy="24" r="3" fill="#77502b"/>'
	},
	saw: {
		name: 'Saw',
		kind: 'cylinder', shape: 'saw',
		defaultSize: { radius: 0.3, width: 0.08 },
		wood: [ 'walnut', 'gloss' ],
		mountAxis: Z_AXIS, mountDepth: 0.04,
		friction: 0.5, restitution: 0.1,
		hp: 80, dmg: 3.2, weapon: true, defaultArmor: 'steel',
		icon: '<polygon points="41,24 34.6,28.4 36,36 28.4,34.6 24,41 19.6,34.6 12,36 13.4,28.4 7,24 13.4,19.6 12,12 19.6,13.4 24,7 28.4,13.4 36,12 34.6,19.6"/><circle cx="24" cy="24" r="4" fill="#5c636e"/>'
	},
	spike: {
		name: 'Spike',
		kind: 'cone',
		defaultSize: { radius: 0.1, height: 0.3 },
		wood: [ 'maple', 'semigloss' ],
		mountAxis: Y_AXIS, mountDepth: 0.15,
		friction: 0.5, restitution: 0.1,
		hp: 90, dmg: 2.2, weapon: true, defaultArmor: 'steel',
		icon: '<polygon points="24,6 34,40 14,40"/>'
	},
	mace: {
		name: 'Mace',
		kind: 'sphere', shape: 'mace',
		defaultSize: { radius: 0.16 },
		wood: [ 'cherry', 'gloss' ],
		mountAxis: Y_AXIS, mountDepth: 0.16,
		friction: 0.6, restitution: 0.2,
		hp: 110, dmg: 2.4, weapon: true, defaultArmor: 'steel',
		icon: '<polygon points="41,24 32.3,27.4 36,36 27.4,32.3 24,41 20.6,32.3 12,36 15.7,27.4 7,24 15.7,20.6 12,12 20.6,15.7 24,7 27.4,15.7 36,12 32.3,20.6"/><circle cx="24" cy="24" r="8"/>'
	}
};

const TYPE_KEYS = Object.keys( TYPES );

// how a bot drives itself — picked per robot, seeded per battle

const AI_STYLES = {
	brawler: { name: 'Brawler', maxSpeed: 3.4 },
	orbiter: { name: 'Circler', maxSpeed: 2.7 },
	skirmisher: { name: 'Skirmisher', maxSpeed: 3.0 }
};

const AI_KEYS = Object.keys( AI_STYLES );

const FIGHTER_COLORS = [ '#e2543e', '#3e8fe2', '#e2a53e', '#52b788', '#b05fd0', '#7f8c8d' ];

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
let METALS = null; // steel / titanium materials, built in init

let mode = 'build';
let robots = [];
let activeBot = null;
let focusBot = null; // camera focus in battle, null = whole arena
let selected = null;
let handles = [];
let drag = null;
let resize = null;
let pivotDrag = null;
let moveDrag = null;
let battle = null;
let battleSeed = 1 + Math.floor( Math.random() * 99999 );

// ?seed=123 pins the battle seed — same seed, same fight

{

	const requested = Number.parseInt( new URLSearchParams( location.search ).get( 'seed' ), 10 );
	if ( Number.isInteger( requested ) && requested > 0 ) battleSeed = requested;

}

// a peek at the running battle, for debugging and curious folk

window.__rw = () => battle === null ? null : battle.fighters.map( ( fighter ) => {

	const dead = fighter.rootRec.destroyed;
	const p = dead ? { x: 0, y: 0, z: 0 } : b3.b3Body_GetPosition( fighter.rootRec.body );
	const v = dead ? { x: 0, y: 0, z: 0 } : b3.b3Body_GetLinearVelocity( fighter.rootRec.body );
	const w = dead ? { x: 0, y: 0, z: 0 } : b3.b3Body_GetAngularVelocity( fighter.rootRec.body );

	const wheelRec = fighter.bodies.find( ( rec ) => rec.destroyed === false && rec.key !== null && rec.key.type === 'wheel' );
	const ws = wheelRec === undefined ? null : b3.b3Body_GetAngularVelocity( wheelRec.body );
	const weaponRec = fighter.bodies.find( ( rec ) => rec.destroyed === false && rec.key !== null && rec.key.spin !== 0 );
	const wps = weaponRec === undefined ? null : b3.b3Body_GetAngularVelocity( weaponRec.body );

	return {
		name: fighter.name,
		alive: fighter.alive,
		status: fighter.status,
		still: Math.round( fighter.still * 10 ) / 10,
		damage: Math.round( fighter.damage ),
		totalHp: Math.round( fighter.totalHp ),
		bodies: fighter.bodies.filter( ( rec ) => rec.destroyed === false ).length,
		awake: dead ? false : b3.b3Body_IsAwake( fighter.rootRec.body ),
		mass: Math.round( fighter.mass ),
		x: Math.round( p.x * 100 ) / 100,
		z: Math.round( p.z * 100 ) / 100,
		speed: Math.round( Math.hypot( v.x, v.y, v.z ) * 100 ) / 100,
		spin: Math.round( Math.hypot( w.x, w.y, w.z ) * 100 ) / 100,
		wheelSpin: ws === null ? null : Math.round( Math.hypot( ws.x, ws.y, ws.z ) * 100 ) / 100,
		weaponSpin: wps === null ? null : Math.round( Math.hypot( wps.x, wps.y, wps.z ) * 100 ) / 100,
		dbg: fighter.dbg ?? null
	};

} );
let physicsAcc = 0;
let restoring = false;
let viewingShared = false; // garage loaded from someone's link
let botCounter = 0;
let commTab = 'top';
let toastTimer = null;

const SAMPLES = makeSamples( TYPE_KEYS, ARMOR_KEYS, AI_KEYS );

const timer = new THREE.Timer();
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const groundPlane = new THREE.Plane( Y_AXIS, 0 );

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

// battle-only temps, so the sim never trips over the build gizmo temps

const _bv1 = new THREE.Vector3();
const _bv2 = new THREE.Vector3();
const _bq1 = new THREE.Quaternion();

const ghostMaterial = new THREE.MeshStandardMaterial( { transparent: true, opacity: 0.5, depthWrite: false, roughness: 0.8 } );
const ringMaterial = new THREE.MeshBasicMaterial( { color: 0xff9f2e, transparent: true, opacity: 0.6, depthWrite: false } );
const dotMaterial = new THREE.MeshStandardMaterial( { color: 0xff9f2e, emissive: 0xff9f2e, emissiveIntensity: 0.25, roughness: 0.35 } );
const dotGeometry = new THREE.SphereGeometry( 0.035, 12, 8 );
const markerGeometry = new THREE.SphereGeometry( 0.055, 16, 12 );
const markerMaterial = new THREE.MeshStandardMaterial( { color: 0x3bb2a0, emissive: 0x3bb2a0, emissiveIntensity: 0.25, roughness: 0.35, depthTest: false } );
const handleGeometry = new THREE.ConeGeometry( 0.05, 0.12, 12 );
const handleMaterial = new THREE.MeshStandardMaterial( { color: 0xff8a2a, emissive: 0xff8a2a, emissiveIntensity: 0.25, roughness: 0.35, transparent: true, opacity: 0.95, depthTest: false } );
const handleHoverMaterial = new THREE.MeshStandardMaterial( { color: 0xffc36b, emissive: 0xffc36b, emissiveIntensity: 0.5, roughness: 0.35, depthTest: false } );

// scorch marks left where hits land

const markGeometry = new THREE.SphereGeometry( 1, 8, 6 );
const markMaterial = new THREE.MeshStandardMaterial( { color: 0x241a12, roughness: 1 } );

// arena dressing

const arenaFloorMaterial = new THREE.MeshStandardMaterial( { color: 0xa8977a, roughness: 0.9 } );
const arenaWallMaterial = new THREE.MeshStandardMaterial( { color: 0x6f5a40, roughness: 0.85 } );
const arenaHazardMaterial = new THREE.MeshStandardMaterial( { color: 0x8a4030, roughness: 0.8 } );
const arenaPostMaterial = new THREE.MeshStandardMaterial( { color: 0x4a3826, roughness: 0.8 } );

function viewSize() {

	// mobile browsers can report a zero-height viewport mid-transition
	// (url bar, keyboard, overlays) — a zero-sized swapchain texture trips
	// webgpu validation and poisons every frame until the next resize

	return {
		width: Math.max( window.innerWidth, 1 ),
		height: Math.max( window.innerHeight, 1 )
	};

}

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
	const size = viewSize();
	renderer.setSize( size.width, size.height );
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type = THREE.PCFShadowMap;
	renderer.toneMapping = THREE.NeutralToneMapping;
	document.body.appendChild( renderer.domElement );

	[ b3 ] = await Promise.all( [ Box3D(), renderer.init() ] );

	eventsBuffer = b3.createEventsBuffer();
	hitEvent = b3.createContactHitEvent();

	METALS = {
		steel: new THREE.MeshStandardMaterial( { color: 0x9aa2ab, metalness: 0.85, roughness: 0.4 } ),
		titanium: new THREE.MeshStandardMaterial( { color: 0x565d6b, metalness: 0.9, roughness: 0.32 } )
	};

	// the TSL wood shader only compiles on real WebGPU — on the WebGL2
	// fallback it renders black, so fall back to plain wood tones there

	const realWebGPU = renderer.backend?.isWebGPUBackend === true;

	const WOOD_TONES = { maple: 0xdcbd8f, teak: 0x9c6b3f, walnut: 0x5d4230, cherry: 0x9c4a33 };

	for ( const def of Object.values( TYPES ) ) {

		def.material = realWebGPU
			? WoodNodeMaterial.fromPreset( def.wood[ 0 ], def.wood[ 1 ] )
			: new THREE.MeshStandardMaterial( { color: WOOD_TONES[ def.wood[ 0 ] ], roughness: def.wood[ 1 ] === 'gloss' ? 0.45 : 0.7 } );
		def.geometry = buildGeometry( def, def.defaultSize ); // ghost preview
		def.volume = volumeFor( def, def.defaultSize );

	}

	scene = new THREE.Scene();
	scene.background = new THREE.Color( 0x9a8b70 );
	scene.fog = new THREE.Fog( 0x9a8b70, 20, 45 );

	camera = new THREE.PerspectiveCamera( 45, size.width / size.height, 0.1, 100 );
	camera.position.set( 3.6, 2.6, 4.6 );

	controls = new OrbitControls( camera, renderer.domElement );
	controls.target.set( 0, 0.4, 0 );
	controls.enableDamping = true;
	controls.dampingFactor = 0.08;
	controls.maxPolarAngle = Math.PI * 0.495;
	controls.minDistance = 2;
	controls.maxDistance = 24;

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

	// scattered tiles on the floor, so you can tell where a bot is heading

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

	initParticles();
	buildPalette();
	bindEvents();
	addBot();
	loadFromHash();
	if ( allPieces().length === 0 ) loadLocal();
	else if ( viewingShared ) loadLocal( true ); // your own bots tag along, benched
	updateHint();
	updateBotBar();

	document.getElementById( 'loading' ).remove();
	renderer.setAnimationLoop( animate );

	if ( viewingShared && allPieces().length > 0 ) {

		// a shared link goes straight to the fight

		setMode( 'battle' );

	} else if ( allPieces().length === 0 ) {

		document.getElementById( 'splash' ).hidden = false;

	}

}

// geometry

function sawGeometry( radius, width ) {

	// a toothed disc — the teeth lean so it reads as a saw from any angle

	const teeth = 10;
	const inner = radius * 0.72;
	const shape = new THREE.Shape();

	for ( let i = 0; i < teeth; i ++ ) {

		const a0 = ( i / teeth ) * Math.PI * 2;
		const a1 = ( ( i + 0.5 ) / teeth ) * Math.PI * 2;
		const a2 = ( ( i + 0.62 ) / teeth ) * Math.PI * 2;

		if ( i === 0 ) shape.moveTo( Math.cos( a0 ) * inner, Math.sin( a0 ) * inner );
		else shape.lineTo( Math.cos( a0 ) * inner, Math.sin( a0 ) * inner );

		shape.lineTo( Math.cos( a1 ) * radius, Math.sin( a1 ) * radius );
		shape.lineTo( Math.cos( a2 ) * inner, Math.sin( a2 ) * inner );

	}

	shape.closePath();

	const geometry = new THREE.ExtrudeGeometry( shape, { depth: width, bevelEnabled: false } );
	geometry.translate( 0, 0, - width / 2 );

	return geometry;

}

function wedgeGeometry( sx, sy, sz ) {

	// a triangular prism, slope facing +x — the classic scoop

	const shape = new THREE.Shape();
	shape.moveTo( - sx / 2, - sy / 2 );
	shape.lineTo( sx / 2, - sy / 2 );
	shape.lineTo( - sx / 2, sy / 2 );
	shape.closePath();

	const geometry = new THREE.ExtrudeGeometry( shape, { depth: sz, bevelEnabled: false } );
	geometry.translate( 0, 0, - sz / 2 );

	return geometry;

}

function maceGeometry( radius ) {

	// a ball bristling with cones, one per icosahedron vertex

	const parts = [ new THREE.SphereGeometry( radius * 0.82, 20, 14 ).toNonIndexed() ];

	const icosa = new THREE.IcosahedronGeometry( 1, 0 );
	const positions = icosa.getAttribute( 'position' );
	const seen = new Set();
	const dir = new THREE.Vector3();
	const quat = new THREE.Quaternion();

	for ( let i = 0; i < positions.count; i ++ ) {

		dir.fromBufferAttribute( positions, i ).normalize();
		const key = `${ dir.x.toFixed( 2 ) },${ dir.y.toFixed( 2 ) },${ dir.z.toFixed( 2 ) }`;
		if ( seen.has( key ) ) continue;
		seen.add( key );

		const spike = new THREE.ConeGeometry( radius * 0.28, radius * 0.9, 8 ).toNonIndexed();
		quat.setFromUnitVectors( Y_AXIS, dir );
		spike.applyQuaternion( quat );
		spike.translate( dir.x * radius * 0.55, dir.y * radius * 0.55, dir.z * radius * 0.55 );
		parts.push( spike );

	}

	icosa.dispose();

	return BufferGeometryUtils.mergeGeometries( parts );

}

function buildGeometry( def, size ) {

	if ( def.shape === 'saw' ) return sawGeometry( size.radius, size.width );
	if ( def.shape === 'mace' ) return maceGeometry( size.radius );

	switch ( def.kind ) {

		case 'box': {

			const chamfer = Math.min( 0.055, Math.min( size.x, size.y, size.z ) * 0.3 );
			return new RoundedBoxGeometry( size.x, size.y, size.z, 2, chamfer );

		}

		case 'cylinder':
			return new THREE.CylinderGeometry( size.radius, size.radius, size.width, 28 ).rotateX( Math.PI / 2 );

		case 'sphere':
			return new THREE.SphereGeometry( size.radius, 32, 20 );

		case 'cone':
			return new THREE.ConeGeometry( size.radius, size.height, 20 );

		case 'wedge':
			return wedgeGeometry( size.x, size.y, size.z );

	}

}

function volumeFor( def, size ) {

	switch ( def.kind ) {

		case 'box': return size.x * size.y * size.z;
		case 'wedge': return size.x * size.y * size.z / 2;
		case 'cylinder': return Math.PI * size.radius * size.radius * size.width;
		case 'sphere': return ( 4 / 3 ) * Math.PI * size.radius ** 3;
		case 'cone': return Math.PI * size.radius * size.radius * size.height / 3;

	}

}

function volumeOf( piece ) {

	return volumeFor( TYPES[ piece.type ], piece.size );

}

function pieceWeight( piece ) {

	return volumeOf( piece ) * DENSITY * ARMORS[ piece.armor ].density;

}

function botWeight( bot ) {

	let total = 0;
	for ( const piece of bot.pieces ) total += pieceWeight( piece );
	return total;

}

function pieceMaxHp( piece ) {

	const def = TYPES[ piece.type ];
	const sizeFactor = Math.max( Math.pow( volumeOf( piece ) / def.volume, 0.6 ), 0.35 );
	return def.hp * ARMORS[ piece.armor ].hp * sizeFactor;

}

function materialFor( type, armor ) {

	return armor === 'wood' ? TYPES[ type ].material : METALS[ armor ];

}

// robots

function allPieces() {

	const list = [];

	for ( const bot of robots ) list.push( ...bot.pieces );

	return list;

}

function setActiveBot( bot ) {

	if ( bot === activeBot ) return;

	select( null );

	activeBot = bot;
	robots = robots.filter( ( b ) => b.pieces.length > 0 || b === bot );

	refreshVisibility();
	updateBotsList();
	updateBotBar();
	updateHint();

}

function addBot() {

	const bot = { pieces: [], inBattle: true, name: `Bot ${ ++ botCounter }`, ai: 0, temp: false };
	robots.push( bot );
	setActiveBot( bot );

	return bot;

}

function refreshVisibility() {

	for ( const bot of robots ) {

		const visible = mode === 'battle' ? bot.inBattle : bot === activeBot;

		for ( const piece of bot.pieces ) piece.mesh.visible = visible;

	}

}

function updateBotsList() {

	const container = document.getElementById( 'robots' );
	container.textContent = '';

	if ( mode === 'battle' ) {

		// in battle the list picks which bot the camera follows

		const all = document.createElement( 'button' );
		all.className = 'bot-btn' + ( focusBot === null ? ' active' : '' );
		all.textContent = 'Whole arena';
		all.addEventListener( 'click', () => { focusBot = null; updateBotsList(); } );
		container.appendChild( all );

		if ( battle !== null ) {

			for ( const fighter of battle.fighters ) {

				const button = document.createElement( 'button' );
				button.className = 'bot-btn' + ( fighter.bot === focusBot ? ' active' : '' );

				const label = document.createElement( 'span' );
				label.className = 'bot-label';
				label.textContent = fighter.name;
				button.appendChild( label );

				button.addEventListener( 'click', () => { focusBot = fighter.bot; updateBotsList(); } );
				container.appendChild( button );

			}

		}

		return;

	}

	robots.forEach( ( bot ) => {

		if ( bot.temp ) return;

		const button = document.createElement( 'button' );
		button.className = 'bot-btn' + ( bot === activeBot ? ' active' : '' );
		button.addEventListener( 'click', () => setActiveBot( bot ) );

		const flag = document.createElement( 'span' );
		flag.className = 'bot-flag' + ( bot.inBattle ? '' : ' off' );
		flag.textContent = '⚔';
		flag.title = 'Fights in battle mode';
		flag.addEventListener( 'click', ( event ) => {

			event.stopPropagation();
			bot.inBattle = ! bot.inBattle;
			updateBotsList();

		} );
		button.appendChild( flag );

		const label = document.createElement( 'span' );
		label.className = 'bot-label';
		label.textContent = bot.name;

		const sub = document.createElement( 'span' );
		sub.className = 'bot-sub';
		sub.textContent = bot.pieces.length === 0 ? 'empty' : `${ botWeight( bot ).toFixed( 1 ) } kg · ${ bot.pieces.length } parts`;
		label.appendChild( sub );

		button.appendChild( label );

		const del = document.createElement( 'span' );
		del.className = 'bot-del';
		del.textContent = '✕';
		del.addEventListener( 'click', ( event ) => { event.stopPropagation(); deleteBot( bot ); } );
		button.appendChild( del );

		container.appendChild( button );

	} );

	const add = document.createElement( 'button' );
	add.className = 'bot-btn new';
	add.textContent = '+ New robot';
	add.addEventListener( 'click', () => addBot() );
	container.appendChild( add );

}

function deleteBot( bot ) {

	if ( bot.pieces.length > 0 && ! window.confirm( `Scrap ${ bot.name }?` ) ) return;

	select( null );

	for ( const piece of bot.pieces ) destroyPiece( piece );
	bot.pieces = [];

	robots = robots.filter( ( b ) => b !== bot );

	if ( robots.length === 0 ) addBot();
	else if ( activeBot === bot ) setActiveBot( robots[ 0 ] );
	else updateBotsList();

	saveLocal();
	updateHint();

}

function botOf( piece ) {

	for ( const bot of robots ) {

		if ( bot.pieces.includes( piece ) ) return bot;

	}

	return null;

}

// the little card in build mode: name, weight, drive style

function updateBotBar() {

	if ( activeBot === null ) return;

	document.getElementById( 'botNameBtn' ).textContent = `✎ ${ activeBot.name }`;
	document.getElementById( 'botWeight' ).textContent = activeBot.pieces.length === 0
		? '⚖ empty'
		: `⚖ ${ botWeight( activeBot ).toFixed( 1 ) } kg`;
	document.getElementById( 'botAiSelect' ).selectedIndex = activeBot.ai;

}

function renameActiveBot() {

	const name = window.prompt( 'Robot name', activeBot.name );
	if ( name === null || name.trim() === '' ) return;

	activeBot.name = name.trim().slice( 0, 24 );
	updateBotBar();
	updateBotsList();
	saveLocal();

}

// sharing + saving — rows are [type, parent, spin, pos, normal, size…, pivot, armor]

function serializeBot( bot ) {

	const r3 = ( value ) => Math.round( value * 1000 ) / 1000;

	const rows = bot.pieces.map( ( piece ) => {

		const size = piece.size;
		const kind = TYPES[ piece.type ].kind;
		const sizeArray = ( kind === 'box' || kind === 'wedge' ) ? [ size.x, size.y, size.z ]
			: kind === 'cylinder' ? [ size.radius, size.width ]
			: kind === 'cone' ? [ size.radius, size.height ]
			: [ size.radius ];

		return [
			TYPE_KEYS.indexOf( piece.type ),
			bot.pieces.indexOf( piece.parent ), // -1 for the bot root
			piece.spin,
			r3( piece.position.x ), r3( piece.position.y ), r3( piece.position.z ),
			piece.attachNormal.x, piece.attachNormal.y, piece.attachNormal.z,
			...sizeArray.map( r3 ),
			r3( piece.pivot.x ), r3( piece.pivot.y ), r3( piece.pivot.z ),
			ARMOR_KEYS.indexOf( piece.armor )
		];

	} );

	return { n: bot.name, a: bot.ai, p: rows };

}

function serializeGarage( rosterOnly = false ) {

	return robots
		.filter( ( bot ) => bot.pieces.length > 0 && bot.temp === false && ( rosterOnly === false || bot.inBattle ) )
		.map( serializeBot );

}

function buildShareUrl( bots ) {

	const url = new URL( location.href );
	url.hash = btoa( JSON.stringify( bots.map( serializeBot ) ) ).replaceAll( '+', '-' ).replaceAll( '/', '_' ).replace( /=+$/, '' );
	return url.href;

}

function loadRobots( data, benched = false ) {

	restoring = true;
	const created = [];

	for ( const entry of data ) {

		// legacy entries are bare row arrays; new ones carry a name and ai style

		const rows = Array.isArray( entry ) ? entry : entry.p;
		if ( ! Array.isArray( rows ) || rows.length === 0 ) continue;

		const bot = addBot();
		if ( Array.isArray( entry ) === false ) {

			if ( typeof entry.n === 'string' && entry.n.trim() !== '' ) bot.name = entry.n.trim().slice( 0, 24 );
			if ( Number.isInteger( entry.a ) && entry.a >= 0 && entry.a < AI_KEYS.length ) bot.ai = entry.a;

		}

		if ( benched ) bot.inBattle = false;
		created.push( bot );

		for ( const row of rows ) {

			const [ typeIndex, parentIndex, spin, x, y, z, nx, ny, nz, ...rest ] = row;

			const type = TYPE_KEYS[ typeIndex ];
			if ( type === undefined ) continue;
			const def = TYPES[ type ];
			const normal = new THREE.Vector3( nx, ny, nz );

			const placement = {
				position: new THREE.Vector3( x, y, z ),
				quaternion: new THREE.Quaternion().setFromUnitVectors( def.mountAxis, normal ),
				normal
			};

			const piece = addPiece( type, placement, parentIndex >= 0 ? bot.pieces[ parentIndex ] : null );

			const kind = def.kind;
			if ( kind === 'box' || kind === 'wedge' ) piece.size = { x: rest[ 0 ], y: rest[ 1 ], z: rest[ 2 ] };
			else if ( kind === 'cylinder' ) piece.size = { radius: rest[ 0 ], width: rest[ 1 ] };
			else if ( kind === 'cone' ) piece.size = { radius: rest[ 0 ], height: rest[ 1 ] };
			else piece.size = { radius: rest[ 0 ] };

			const sizeCount = ( kind === 'box' || kind === 'wedge' ) ? 3 : kind === 'sphere' ? 1 : 2;

			if ( rest.length >= sizeCount + 3 ) piece.pivot.set( rest[ sizeCount ], rest[ sizeCount + 1 ], rest[ sizeCount + 2 ] );

			if ( rest.length >= sizeCount + 4 ) {

				const armor = ARMOR_KEYS[ rest[ sizeCount + 3 ] ];
				if ( armor !== undefined ) piece.armor = armor;

			}

			piece.mesh.geometry.dispose();
			piece.mesh.geometry = buildGeometry( def, piece.size );
			piece.mesh.material = materialFor( piece.type, piece.armor );

			if ( spin !== 0 ) setSpin( piece, spin );

		}

	}

	restoring = false;

	return created;

}

function loadFromHash() {

	const hash = location.hash.slice( 1 );
	if ( hash === '' ) return;

	try {

		const bots = loadRobots( JSON.parse( atob( hash.replaceAll( '-', '+' ).replaceAll( '_', '/' ) ) ) );
		if ( bots.length > 0 ) setActiveBot( bots[ 0 ] );
		viewingShared = true;

	} catch ( error ) {

		console.warn( 'could not load robots from url', error );

	} finally {

		restoring = false;

	}

}

function saveLocal() {

	if ( restoring ) return;

	// an edit makes the garage yours again — drop any shared-link hash

	if ( location.hash !== '' ) history.replaceState( null, '', location.pathname + location.search );

	try {

		if ( serializeGarage().length > 0 ) localStorage.setItem( STORAGE_KEY, JSON.stringify( serializeGarage() ) );
		else localStorage.removeItem( STORAGE_KEY );

	} catch ( error ) {

		// storage unavailable — not fatal

	}

}

function loadLocal( benched = false ) {

	try {

		const json = localStorage.getItem( STORAGE_KEY );

		if ( json !== null ) {

			const bots = loadRobots( JSON.parse( json ), benched );
			if ( benched === false && bots.length > 0 ) setActiveBot( bots[ 0 ] );

		}

	} catch ( error ) {

		console.warn( 'could not load saved robots', error );

	} finally {

		restoring = false;

	}

}

function loadSampleBots( benched = false ) {

	const bots = loadRobots( SAMPLES, benched );
	saveLocal();
	updateBotsList();

	return bots;

}

// share: a link with the creation encoded in the url — the current robot
// from the workshop, or the whole roster from a battle

function openShare() {

	if ( mode === 'battle' ) {

		const roster = robots.filter( ( bot ) => bot.pieces.length > 0 && bot.inBattle );
		if ( roster.length === 0 ) return;

		shareUrl = buildShareUrl( roster );
		document.getElementById( 'shareLinkLabel' ).textContent = 'Share this battle';

	} else {

		if ( activeBot === null || activeBot.pieces.length === 0 ) {

			showToast( 'build something first — then share it' );
			return;

		}

		shareUrl = buildShareUrl( [ activeBot ] );
		document.getElementById( 'shareLinkLabel' ).textContent = `Share ${ activeBot.name }`;

	}

	showShareModal( null );

}

// recording: a manual start/stop clip of the fight

function toggleRecording() {

	if ( recording !== null ) {

		if ( recording.finishing === false ) finishRecording();
		return;

	}

	if ( mode !== 'battle' ) setMode( 'battle' );
	if ( mode !== 'battle' ) return; // no roster — setMode refused

	if ( 'VideoEncoder' in window ) {

		try {

			startRecording();

		} catch ( error ) {

			console.warn( 'recording unavailable', error );
			showToast( 'recording is not supported in this browser' );

		}

	} else {

		showToast( 'recording is not supported in this browser' );

	}

	updateRecButton();

}

function updateRecButton() {

	const button = document.getElementById( 'recBtn' );
	button.textContent = recording !== null && recording.finishing === false ? '■ Stop' : '● Rec';
	button.classList.toggle( 'recording', recording !== null );

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
	document.getElementById( 'recBadge' ).textContent = `● recording · ${ ( rec.frame / REC_FPS ).toFixed( 1 ) }s — press stop when done`;

	if ( rec.frame >= REC_MAX_FRAMES ) finishRecording();

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
		updateRecButton();

		const roster = robots.filter( ( bot ) => bot.pieces.length > 0 && bot.inBattle );
		shareUrl = buildShareUrl( roster );
		document.getElementById( 'shareLinkLabel' ).textContent = 'Share this battle';
		showShareModal( new Blob( [ mp4 ], { type: 'video/mp4' } ) );

	} catch ( error ) {

		console.error( error );
		recording = null;
		updateRecButton();

	}

}

function abortRecording() {

	if ( recording === null ) return;

	recording.aborted = true;

	try { recording.encoder.close(); } catch ( error ) { /* already closed */ }

	recording = null;
	document.getElementById( 'recBadge' ).hidden = true;
	updateRecButton();

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

// community — a tiny api backs publishing and pulling public bots.
// no accounts: a random key minted per browser marks what is yours.

function ownerKey() {

	let key = localStorage.getItem( 'rw-key' );

	if ( key === null ) {

		key = crypto.randomUUID();
		localStorage.setItem( 'rw-key', key );

	}

	return key;

}

async function api( path, options = {} ) {

	const response = await fetch( path, {
		headers: { 'Content-Type': 'application/json' },
		signal: AbortSignal.timeout( 8000 ),
		...options
	} );

	const body = await response.json().catch( () => ( {} ) );
	if ( ! response.ok ) throw new Error( body.error ?? `request failed (${ response.status })` );

	return body;

}

function showToast( text ) {

	document.getElementById( 'hint' ).textContent = text;
	clearTimeout( toastTimer );
	toastTimer = setTimeout( updateHint, 2600 );

}

function openCommunity() {

	document.getElementById( 'communityModal' ).hidden = false;
	renderCommunity( commTab );

}

function closeCommunity() {

	document.getElementById( 'communityModal' ).hidden = true;

}

async function renderCommunity( tab ) {

	commTab = tab;

	for ( const button of document.querySelectorAll( '#commTabs button' ) ) {

		button.classList.toggle( 'active', button.dataset.tab === tab );

	}

	const list = document.getElementById( 'commList' );
	const status = document.getElementById( 'commStatus' );
	list.textContent = '';
	status.textContent = 'loading…';

	try {

		const query = tab === 'mine' ? `?mine=1&key=${ ownerKey() }` : `?sort=${ tab }`;
		const { robots: entries } = await api( '/api/robots' + query );

		status.textContent = entries.length === 0
			? ( tab === 'mine' ? 'nothing published yet' : 'no public bots yet — publish the first one!' )
			: '';

		for ( const entry of entries ) {

			const row = document.createElement( 'div' );
			row.className = 'comm-row';

			const info = document.createElement( 'div' );
			info.className = 'comm-info';

			const name = document.createElement( 'div' );
			name.className = 'comm-name';
			name.textContent = entry.name;
			info.appendChild( name );

			const meta = document.createElement( 'div' );
			meta.className = 'comm-meta';
			const parts = Array.isArray( entry.data?.p ) ? entry.data.p.length : 0;
			meta.textContent = `${ entry.author || 'anon' } · ${ parts } parts · ⬇ ${ entry.downloads }`;
			info.appendChild( meta );

			row.appendChild( info );

			const importBtn = document.createElement( 'button' );
			importBtn.textContent = 'Import';
			importBtn.addEventListener( 'click', () => importCommunityBot( entry ) );
			row.appendChild( importBtn );

			if ( tab === 'mine' ) {

				const delBtn = document.createElement( 'button' );
				delBtn.className = 'danger';
				delBtn.textContent = 'Unpublish';
				delBtn.addEventListener( 'click', async () => {

					try {

						await api( `/api/robots/${ entry.id }?key=${ ownerKey() }`, { method: 'DELETE' } );
						renderCommunity( 'mine' );

					} catch ( error ) {

						status.textContent = error.message;

					}

				} );
				row.appendChild( delBtn );

			}

			list.appendChild( row );

		}

	} catch ( error ) {

		status.textContent = 'community is offline — deploy with a database to enable sharing';

	}

}

function importCommunityBot( entry ) {

	const bots = loadRobots( [ entry.data ] );
	if ( bots.length === 0 ) return;

	setActiveBot( bots[ 0 ] );
	saveLocal();
	updateBotsList();
	updateBotBar();
	closeCommunity();
	showToast( `${ bots[ 0 ].name } rolled into the garage` );

	// count the download, best effort

	api( `/api/robots/${ entry.id }?dl=1` ).catch( () => {} );

}

async function publishActiveBot() {

	if ( activeBot === null || activeBot.pieces.length === 0 ) {

		document.getElementById( 'commStatus' ).textContent = 'the current robot is empty — build something first';
		return;

	}

	let author = localStorage.getItem( 'rw-author' );

	if ( author === null ) {

		author = ( window.prompt( 'Builder name to publish under', '' ) ?? '' ).trim().slice( 0, 24 );
		localStorage.setItem( 'rw-author', author );

	}

	const status = document.getElementById( 'commStatus' );
	status.textContent = 'publishing…';

	try {

		await api( '/api/robots', {
			method: 'POST',
			body: JSON.stringify( { key: ownerKey(), name: activeBot.name, author, data: serializeBot( activeBot ) } )
		} );

		status.textContent = `${ activeBot.name } published!`;
		renderCommunity( commTab === 'mine' ? 'mine' : 'new' );

	} catch ( error ) {

		status.textContent = error.message;

	}

}

// UI

function buildPalette() {

	const palette = document.getElementById( 'palette' );

	let weaponsLabelled = false;

	const chassisLabel = document.createElement( 'div' );
	chassisLabel.className = 'palette-label';
	chassisLabel.textContent = 'chassis';
	palette.appendChild( chassisLabel );

	for ( const [ type, def ] of Object.entries( TYPES ) ) {

		if ( def.weapon && weaponsLabelled === false ) {

			const label = document.createElement( 'div' );
			label.className = 'palette-label';
			label.textContent = 'weapons';
			palette.appendChild( label );
			weaponsLabelled = true;

		}

		const item = document.createElement( 'div' );
		item.className = 'piece-btn' + ( def.weapon ? ' weapon' : '' );
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

		if ( mode === 'battle' ) {

			// click a bot to follow it, click the floor for the wide shot

			const hits = raycaster.intersectObjects( allPieces().map( ( p ) => p.mesh ), false );
			focusBot = hits.length > 0 ? botOf( hits[ 0 ].object.userData.piece ) : null;
			updateBotsList();
			return;

		}

		const hits = raycaster.intersectObjects( activeBot.pieces.map( ( p ) => p.mesh ), false );
		select( hits.length > 0 ? hits[ 0 ].object.userData.piece : null );

	} );

	document.getElementById( 'buildBtn' ).addEventListener( 'click', ( event ) => { setMode( 'build' ); event.target.blur(); } );
	document.getElementById( 'battleBtn' ).addEventListener( 'click', ( event ) => { setMode( 'battle' ); event.target.blur(); } );
	document.getElementById( 'shareBtn' ).addEventListener( 'click', ( event ) => { openShare(); event.target.blur(); } );
	document.getElementById( 'communityBtn' ).addEventListener( 'click', ( event ) => { openCommunity(); event.target.blur(); } );
	document.getElementById( 'closeShareBtn' ).addEventListener( 'click', closeShareModal );
	document.getElementById( 'closeCommunityBtn' ).addEventListener( 'click', closeCommunity );
	document.getElementById( 'publishBtn' ).addEventListener( 'click', publishActiveBot );

	document.getElementById( 'samplesBtn' ).addEventListener( 'click', () => {

		const bots = loadSampleBots();
		if ( bots.length > 0 ) setActiveBot( bots[ 0 ] );
		saveLocal();
		closeCommunity();
		showToast( 'sample bots rolled into the garage' );

	} );

	document.getElementById( 'rematchBtn' ).addEventListener( 'click', ( event ) => { resetBattle(); event.target.blur(); } );
	document.getElementById( 'editBtn' ).addEventListener( 'click', ( event ) => { setMode( 'build' ); event.target.blur(); } );
	document.getElementById( 'recBtn' ).addEventListener( 'click', ( event ) => { toggleRecording(); event.target.blur(); } );

	document.getElementById( 'battleSeed' ).addEventListener( 'click', ( event ) => {

		battleSeed = 1 + Math.floor( Math.random() * 99999 );
		if ( battle !== null ) resetBattle();
		event.target.blur();

	} );

	document.getElementById( 'botNameBtn' ).addEventListener( 'click', renameActiveBot );

	const aiSelect = document.getElementById( 'botAiSelect' );

	for ( const key of AI_KEYS ) {

		const option = document.createElement( 'option' );
		option.textContent = `AI: ${ AI_STYLES[ key ].name }`;
		aiSelect.appendChild( option );

	}

	aiSelect.addEventListener( 'change', () => {

		activeBot.ai = aiSelect.selectedIndex;
		saveLocal();
		aiSelect.blur();

	} );

	document.getElementById( 'watchBtn' ).addEventListener( 'click', () => {

		document.getElementById( 'splash' ).hidden = true;

		if ( serializeGarage().length === 0 ) loadSampleBots();

		// stage a random pair so every first visit opens a different fight

		const stocked = robots.filter( ( bot ) => bot.pieces.length > 0 );
		const first = Math.floor( Math.random() * stocked.length );
		let second = Math.floor( Math.random() * ( stocked.length - 1 ) );
		if ( second >= first ) second ++;

		stocked.forEach( ( bot, i ) => { bot.inBattle = ( i === first || i === second ); } );

		setMode( 'battle' );

	} );

	document.getElementById( 'buildOwnBtn' ).addEventListener( 'click', () => {

		document.getElementById( 'splash' ).hidden = true;

		if ( serializeGarage().length === 0 ) loadSampleBots();
		if ( robots.length > 0 ) setActiveBot( robots[ 0 ] );
		updateBotsList();

	} );

	document.getElementById( 'shareModal' ).addEventListener( 'click', ( event ) => {

		if ( event.target === event.currentTarget ) closeShareModal();

	} );

	document.getElementById( 'communityModal' ).addEventListener( 'click', ( event ) => {

		if ( event.target === event.currentTarget ) closeCommunity();

	} );

	for ( const button of document.querySelectorAll( '#commTabs button' ) ) {

		button.addEventListener( 'click', () => renderCommunity( button.dataset.tab ) );

	}

	document.getElementById( 'copyLinkBtn' ).addEventListener( 'click', ( event ) => {

		if ( navigator.clipboard ) navigator.clipboard.writeText( document.getElementById( 'shareLink' ).value );
		event.target.textContent = 'Copied!';
		setTimeout( () => { event.target.textContent = 'Copy'; }, 1500 );

	} );
	document.getElementById( 'spinBtn' ).addEventListener( 'click', cycleSpin );
	document.getElementById( 'armorBtn' ).addEventListener( 'click', cycleArmor );
	document.getElementById( 'duplicateBtn' ).addEventListener( 'click', duplicateSelected );
	document.getElementById( 'deleteBtn' ).addEventListener( 'click', deleteSelected );

	window.addEventListener( 'keydown', ( event ) => {

		if ( document.getElementById( 'shareModal' ).hidden === false ) {

			if ( event.code === 'Escape' ) closeShareModal();
			return;

		}

		if ( document.getElementById( 'communityModal' ).hidden === false ) {

			if ( event.code === 'Escape' ) closeCommunity();
			return;

		}

		if ( document.getElementById( 'splash' ).hidden === false ) return;

		if ( event.code === 'Space' ) {

			event.preventDefault();
			setMode( mode === 'build' ? 'battle' : 'build' );
			return;

		}

		if ( event.code === 'KeyR' && mode === 'battle' ) resetBattle();

		if ( mode !== 'build' ) return;

		if ( event.code === 'KeyS' && selected !== null ) cycleSpin();
		if ( event.code === 'KeyA' && selected !== null ) cycleArmor();
		if ( event.code === 'KeyD' && selected !== null ) duplicateSelected();
		if ( ( event.code === 'Delete' || event.code === 'Backspace' ) && selected !== null ) deleteSelected();

		if ( event.code === 'Escape' ) {

			if ( moveDrag !== null ) cancelMoveDrag();
			else select( null );

		}

	} );

	window.addEventListener( 'resize', () => {

		const size = viewSize();

		camera.aspect = size.width / size.height;
		camera.updateProjectionMatrix();
		renderer.setSize( size.width, size.height );

	} );

}

function updateToolbar() {

	const toolbar = document.getElementById( 'toolbar' );
	toolbar.hidden = ! ( mode === 'build' && selected !== null );

	if ( selected !== null ) {

		const label = selected.spin === 0 ? 'Spin: off' : selected.spin === 1 ? 'Spin: ⟳' : 'Spin: ⟲';
		document.getElementById( 'spinBtn' ).textContent = label;
		document.getElementById( 'armorBtn' ).textContent = `Armor: ${ ARMORS[ selected.armor ].name }`;

	}

}

function updateHint() {

	const hint = document.getElementById( 'hint' );

	if ( mode === 'battle' ) {

		hint.textContent = 'click a bot to follow · R — rematch · space — build';

	} else if ( activeBot === null || activeBot.pieces.length === 0 ) {

		hint.textContent = 'drag a piece onto the floor to start a robot — weapons that spin do the damage';

	} else if ( selected !== null ) {

		hint.textContent = selected.spin !== 0
			? 'drag the pin to move the spin axis · handles resize · A — armor · S — spin · delete — remove'
			: 'drag the orange handles to resize · A — armor · S — spin · delete — remove · space — battle';

	} else {

		hint.textContent = 'drag palette pieces to add · drag bot pieces to move · space — battle';

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

	if ( def.kind === 'box' || def.kind === 'wedge' ) return piece.size.y / 2;
	if ( def.kind === 'cylinder' ) return piece.size.width / 2;
	if ( def.kind === 'cone' ) return piece.size.height / 2;

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

	if ( activeBot.pieces.length > 0 ) {

		const hits = raycaster.intersectObjects( activeBot.pieces.map( ( p ) => p.mesh ), false );

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

	// the floor only accepts the first piece of a bot — new bots start from the list

	drag.valid = drag.placement !== null && ( activeBot.pieces.length === 0 || drag.parent !== null );

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

function addPiece( type, placement, parent, armor ) {

	const def = TYPES[ type ];
	const size = { ...def.defaultSize };
	armor = armor ?? def.defaultArmor;

	const mesh = new THREE.Mesh( buildGeometry( def, size ), materialFor( type, armor ) );
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	mesh.position.copy( placement.position );
	mesh.quaternion.copy( placement.quaternion );

	const piece = {
		type, mesh, parent, size, armor,
		spin: 0,
		pivot: new THREE.Vector3(), // spin axis offset, local, ⊥ mount axis
		position: placement.position.clone(),
		quaternion: placement.quaternion.clone(),
		attachNormal: placement.normal.clone(),
		indicator: null
	};

	mesh.userData.piece = piece;
	activeBot.pieces.push( piece );
	scene.add( mesh );

	updateBotsList();
	updateBotBar();
	saveLocal();

	return piece;

}

function collectSubtree( piece, bot = activeBot ) {

	const list = [ piece ];

	for ( const other of bot.pieces ) {

		if ( other.parent === piece ) list.push( ...collectSubtree( other, bot ) );

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

function cycleArmor() {

	if ( selected === null ) return;

	const next = ARMOR_KEYS[ ( ARMOR_KEYS.indexOf( selected.armor ) + 1 ) % ARMOR_KEYS.length ];
	selected.armor = next;
	selected.mesh.material = materialFor( selected.type, next );

	updateToolbar();
	updateBotBar();
	updateBotsList();
	saveLocal();

}

function ringRadiusFor( piece ) {

	const size = piece.size;
	const kind = TYPES[ piece.type ].kind;

	if ( kind === 'box' || kind === 'wedge' ) return Math.max( size.x, size.z ) / 2 + 0.08;

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

	const piece = addPiece( old.type, placement, parent, old.armor );

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

		// duplicating the root copies the whole bot into a new slot

		const original = selected;
		const oldName = activeBot.name;
		const oldAi = activeBot.ai;
		const bot = addBot();
		bot.name = `${ oldName } II`.slice( 0, 24 );
		bot.ai = oldAi;

		for ( const old of source ) {

			const placement = {
				position: old.position.clone(),
				quaternion: old.quaternion.clone(),
				normal: old.attachNormal.clone()
			};

			cloneOf.set( old, clonePiece( old, cloneOf.get( old.parent ) ?? null, placement, old.spin, old.pivot ) );

		}

		updateBotBar();
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

	activeBot.pieces = activeBot.pieces.filter( ( piece ) => ! doomed.has( piece ) );

	select( null );
	updateBotsList();
	updateBotBar();
	saveLocal();
	updateHint();

}

// resize handles

function resizeKindFor( type, dirLocal ) {

	const kind = TYPES[ type ].kind;

	if ( kind === 'sphere' ) return 'radius';
	if ( kind === 'cylinder' ) return Math.abs( dirLocal.z ) > 0.5 ? 'width' : 'radius';
	if ( kind === 'cone' ) return Math.abs( dirLocal.y ) > 0.5 ? 'height' : 'radius';

	return Math.abs( dirLocal.x ) > 0.5 ? 'x' : Math.abs( dirLocal.y ) > 0.5 ? 'y' : 'z';

}

function handleOffsetFor( piece, dirLocal ) {

	const kind = resizeKindFor( piece.type, dirLocal );
	const margin = 0.11;

	if ( kind === 'radius' ) return piece.size.radius + margin;
	if ( kind === 'width' ) return piece.size.width / 2 + margin;
	if ( kind === 'height' ) return piece.size.height / 2 + margin;

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

		const max = piece.type === 'wheel' ? 1.0 : piece.type === 'saw' ? 0.6 : piece.type === 'mace' ? 0.4 : 0.9;
		return THREE.MathUtils.clamp( delta, 0.08 - size0.radius, max - size0.radius );

	}

	if ( kind === 'width' ) return THREE.MathUtils.clamp( delta, 0.06 - size0.width, 0.9 - size0.width );
	if ( kind === 'height' ) return THREE.MathUtils.clamp( delta, 0.15 - size0.height, 0.8 - size0.height );

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
	const axisWorld = TYPES[ piece.type ].kind === 'cylinder' ? Z_AXIS.clone().applyQuaternion( piece.quaternion ) : null;

	for ( const child of activeBot.pieces ) {

		if ( child.parent !== piece ) continue;

		let shiftDir = null;

		if ( kind === 'x' || kind === 'y' || kind === 'z' || kind === 'width' || kind === 'height' ) {

			if ( child.attachNormal.dot( dirWorld ) > 0.9 ) shiftDir = dirWorld;

		} else if ( TYPES[ piece.type ].kind === 'sphere' ) {

			shiftDir = child.attachNormal;

		} else if ( axisWorld !== null && Math.abs( child.attachNormal.dot( axisWorld ) ) < 0.5 ) {

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
		else if ( kind === 'height' ) piece.size.height = size0.height + delta;
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

// moving pieces — drag a piece to re-attach it (or the root to move the bot)

function onMoveStart( event ) {

	if ( mode !== 'build' || drag !== null || resize !== null || pivotDrag !== null || moveDrag !== null ) return;
	if ( event.button !== 0 ) return; // right-drag on a piece still pans

	setRayFromEvent( event );
	const hits = raycaster.intersectObjects( activeBot.pieces.map( ( p ) => p.mesh ), false );
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

		const targets = activeBot.pieces.filter( ( p ) => ! subtreeSet.has( p ) ).map( ( p ) => p.mesh );
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

		// the root slides across the floor, taking the whole bot with it

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

	updateBotBar();
	updateBotsList();
	saveLocal();

}

// audio — synthesised knocks, clangs and crunches for the fight

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

function panForPoint( point ) {

	if ( audio === null ) return null;

	const pan = audio.ctx.createStereoPanner();
	_v1.set( point.x, point.y, point.z ).project( camera );
	pan.pan.value = THREE.MathUtils.clamp( _v1.x, - 0.8, 0.8 );
	pan.connect( audio.master );

	return pan;

}

// inharmonic mode ratios of a struck bar — wood dies fast, metal rings

const KNOCK_RATIOS = [ 1, 2.42, 3.83, 5.11 ];
const KNOCK_GAINS = [ 1, 0.45, 0.24, 0.12 ];
const CLANG_RATIOS = [ 1, 2.76, 5.4, 8.93 ];
const CLANG_GAINS = [ 1, 0.6, 0.35, 0.18 ];

function playHit( point, speed, metal ) {

	if ( audio === null || audio.ctx.state !== 'running' ) return;

	const ctx = audio.ctx;
	const time = ctx.currentTime;

	const strength = Math.min( speed / 6, 1 ) ** 2;
	const ratios = metal ? CLANG_RATIOS : KNOCK_RATIOS;
	const gains = metal ? CLANG_GAINS : KNOCK_GAINS;
	const frequency = metal ? 380 + Math.random() * 320 : 160 + Math.random() * 180;
	const baseDecay = metal ? 0.22 : 0.07;

	const pan = panForPoint( point );

	// modal ring: inharmonic partials, each dying at its own rate,
	// the higher ones only waking up on harder hits

	for ( let i = 0; i < ratios.length; i ++ ) {

		const brightness = i === 0 ? 1 : 0.35 + 0.65 * strength;
		const amplitude = 0.55 * strength * gains[ i ] * brightness;
		const decay = baseDecay * ( 1 + strength * 0.6 ) / ( 1 + i * 0.8 );

		const gain = ctx.createGain();
		gain.gain.setValueAtTime( amplitude, time );
		gain.gain.exponentialRampToValueAtTime( 0.001, time + decay );
		gain.connect( pan );

		const osc = ctx.createOscillator();
		osc.frequency.value = frequency * ratios[ i ] * ( 0.98 + Math.random() * 0.04 );
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

function playCrunch( point ) {

	if ( audio === null || audio.ctx.state !== 'running' ) return;

	const ctx = audio.ctx;
	const time = ctx.currentTime;
	const pan = panForPoint( point );

	// splintering: a burst of low noise plus a couple of dying knocks

	const gain = ctx.createGain();
	gain.gain.setValueAtTime( 0.7, time );
	gain.gain.exponentialRampToValueAtTime( 0.001, time + 0.22 );

	const filter = ctx.createBiquadFilter();
	filter.type = 'lowpass';
	filter.frequency.setValueAtTime( 1600, time );
	filter.frequency.exponentialRampToValueAtTime( 300, time + 0.2 );

	for ( let i = 0; i < 3; i ++ ) {

		const src = ctx.createBufferSource();
		src.buffer = audio.noise;
		src.playbackRate.value = 0.5 + Math.random();
		src.loop = true;
		src.connect( filter );
		src.start( time + i * 0.03 );
		src.stop( time + 0.25 );

	}

	filter.connect( gain ).connect( pan );

}

function playHorn() {

	if ( audio === null || audio.ctx.state !== 'running' ) return;

	const ctx = audio.ctx;
	const time = ctx.currentTime;

	// the end-of-fight klaxon — two detuned squares through a lowpass

	const gain = ctx.createGain();
	gain.gain.setValueAtTime( 0.0001, time );
	gain.gain.exponentialRampToValueAtTime( 0.35, time + 0.03 );
	gain.gain.setValueAtTime( 0.35, time + 0.55 );
	gain.gain.exponentialRampToValueAtTime( 0.001, time + 0.85 );

	const filter = ctx.createBiquadFilter();
	filter.type = 'lowpass';
	filter.frequency.value = 900;
	filter.connect( gain );
	gain.connect( audio.master );

	for ( const freq of [ 220, 277 ] ) {

		const osc = ctx.createOscillator();
		osc.type = 'square';
		osc.frequency.value = freq;
		osc.connect( filter );
		osc.start( time );
		osc.stop( time + 0.9 );

	}

}

// particles — one pool of unlit chips for sparks / splinters / flames,
// one pool of soft spheres for smoke

let solidPool = null;
let smokePool = null;

const _pv = new THREE.Vector3();
const _pv2 = new THREE.Vector3();
const _pq = new THREE.Quaternion();
const _pm = new THREE.Matrix4();
const _pc = new THREE.Color();
const ZERO_MATRIX = new THREE.Matrix4().makeScale( 0, 0, 0 );

function makePool( count, geometry, material ) {

	const mesh = new THREE.InstancedMesh( geometry, material, count );
	mesh.instanceMatrix.setUsage( THREE.DynamicDrawUsage );
	mesh.frustumCulled = false;

	const white = new THREE.Color( 0xffffff );

	for ( let i = 0; i < count; i ++ ) {

		mesh.setMatrixAt( i, ZERO_MATRIX );
		mesh.setColorAt( i, white );

	}

	scene.add( mesh );

	const items = [];

	for ( let i = 0; i < count; i ++ ) {

		items.push( {
			life: 0, maxLife: 1,
			pos: new THREE.Vector3(), vel: new THREE.Vector3(),
			size: 0.03, gravity: 0, grow: 0, spin: 0, angle: 0,
			colorFrom: new THREE.Color(), colorTo: new THREE.Color()
		} );

	}

	return { mesh, items, count, cursor: 0 };

}

function initParticles() {

	solidPool = makePool( 500, new THREE.BoxGeometry( 1, 1, 1 ), new THREE.MeshBasicMaterial( { toneMapped: false } ) );
	smokePool = makePool( 160, new THREE.SphereGeometry( 1, 8, 6 ), new THREE.MeshStandardMaterial( { transparent: true, opacity: 0.3, roughness: 1, depthWrite: false } ) );

}

function spawnParticle( pool, options ) {

	const item = pool.items[ pool.cursor ];
	pool.cursor = ( pool.cursor + 1 ) % pool.count;

	item.life = item.maxLife = options.life;
	item.pos.copy( options.pos );
	item.vel.copy( options.vel );
	item.size = options.size;
	item.gravity = options.gravity ?? 0;
	item.grow = options.grow ?? 0; // negative shrinks over life, positive grows
	item.spin = options.spin ?? 0;
	item.angle = Math.random() * Math.PI * 2;
	item.colorFrom.set( options.colorFrom );
	item.colorTo.set( options.colorTo ?? options.colorFrom );

}

function updatePool( pool, dt ) {

	const mesh = pool.mesh;

	for ( let i = 0; i < pool.count; i ++ ) {

		const item = pool.items[ i ];

		if ( item.life <= 0 ) continue;

		item.life -= dt;

		if ( item.life <= 0 ) {

			mesh.setMatrixAt( i, ZERO_MATRIX );
			continue;

		}

		item.vel.y += item.gravity * dt;
		item.pos.addScaledVector( item.vel, dt );
		item.angle += item.spin * dt;

		const t = 1 - item.life / item.maxLife; // 0 → 1 over the particle's life
		const scale = item.size * Math.max( 1 + item.grow * t, 0.01 );

		_pq.setFromAxisAngle( Y_AXIS, item.angle );
		_pm.compose( item.pos, _pq, _pv.set( scale, scale, scale ) );
		mesh.setMatrixAt( i, _pm );

		_pc.copy( item.colorFrom ).lerp( item.colorTo, t );
		mesh.setColorAt( i, _pc );

	}

	mesh.instanceMatrix.needsUpdate = true;
	if ( mesh.instanceColor !== null ) mesh.instanceColor.needsUpdate = true;

}

function updateParticles( dt ) {

	if ( solidPool === null ) return;

	updatePool( solidPool, dt );
	updatePool( smokePool, dt );

}

function clearParticles() {

	if ( solidPool === null ) return;

	for ( const pool of [ solidPool, smokePool ] ) {

		for ( let i = 0; i < pool.count; i ++ ) {

			pool.items[ i ].life = 0;
			pool.mesh.setMatrixAt( i, ZERO_MATRIX );

		}

		pool.mesh.instanceMatrix.needsUpdate = true;

	}

}

function emitSparks( point, count, metal ) {

	for ( let i = 0; i < count; i ++ ) {

		_pv.set( Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5 ).normalize().multiplyScalar( 1.5 + Math.random() * 3.5 );

		spawnParticle( solidPool, {
			pos: point, vel: _pv,
			life: 0.25 + Math.random() * 0.4,
			size: metal ? 0.02 + Math.random() * 0.02 : 0.03 + Math.random() * 0.025,
			gravity: - 9,
			grow: - 0.7,
			spin: ( Math.random() - 0.5 ) * 20,
			colorFrom: metal ? 0xffe08a : 0xa07a4c,
			colorTo: metal ? 0xff5a2a : 0x5c4326
		} );

	}

}

function emitFlame( point ) {

	_pv.set( ( Math.random() - 0.5 ) * 0.4, 0.7 + Math.random() * 0.7, ( Math.random() - 0.5 ) * 0.4 );

	spawnParticle( solidPool, {
		pos: point, vel: _pv,
		life: 0.3 + Math.random() * 0.3,
		size: 0.05 + Math.random() * 0.04,
		gravity: 0,
		grow: - 0.85,
		spin: ( Math.random() - 0.5 ) * 8,
		colorFrom: 0xffb347,
		colorTo: 0xe23c1e
	} );

}

function emitSmoke( point ) {

	_pv.set( ( Math.random() - 0.5 ) * 0.3, 0.5 + Math.random() * 0.4, ( Math.random() - 0.5 ) * 0.3 );

	const shade = 0.35 + Math.random() * 0.3;
	_pc.setRGB( shade, shade, shade );

	spawnParticle( smokePool, {
		pos: point, vel: _pv,
		life: 1.0 + Math.random() * 0.8,
		size: 0.04 + Math.random() * 0.03,
		gravity: 0.1,
		grow: 2.2,
		colorFrom: _pc.getHex(),
		colorTo: 0xbbbbbb
	} );

}

function emitExplosion( point, big ) {

	emitSparks( point, big ? 36 : 16, true );
	emitSparks( point, big ? 14 : 6, false );

	for ( let i = 0; i < ( big ? 8 : 4 ); i ++ ) {

		// not _pv — emitSmoke claims that one for its velocity

		_pv2.copy( point );
		_pv2.x += ( Math.random() - 0.5 ) * 0.3;
		_pv2.z += ( Math.random() - 0.5 ) * 0.3;
		emitSmoke( _pv2 );

	}

}

function emitConfetti( point ) {

	for ( let i = 0; i < 60; i ++ ) {

		_pv.set( Math.random() - 0.5, Math.random() * 1.4 + 0.6, Math.random() - 0.5 ).normalize().multiplyScalar( 2.5 + Math.random() * 3 );
		_pc.setHSL( Math.random(), 0.85, 0.6 );

		spawnParticle( solidPool, {
			pos: point, vel: _pv,
			life: 0.9 + Math.random() * 0.9,
			size: 0.035,
			gravity: - 3.5,
			spin: ( Math.random() - 0.5 ) * 25,
			colorFrom: _pc.getHex()
		} );

	}

}

// battle mode

function colliderLocalPoints( piece ) {

	const def = TYPES[ piece.type ];
	const points = [];

	if ( def.kind === 'box' ) {

		const hx = piece.size.x / 2, hy = piece.size.y / 2, hz = piece.size.z / 2;

		for ( const sx of [ - 1, 1 ] )
			for ( const sy of [ - 1, 1 ] )
				for ( const sz of [ - 1, 1 ] )
					points.push( new THREE.Vector3( sx * hx, sy * hy, sz * hz ) );

	} else if ( def.kind === 'wedge' ) {

		const hx = piece.size.x / 2, hy = piece.size.y / 2, hz = piece.size.z / 2;

		for ( const sz of [ - 1, 1 ] ) {

			points.push(
				new THREE.Vector3( - hx, - hy, sz * hz ),
				new THREE.Vector3( hx, - hy, sz * hz ),
				new THREE.Vector3( - hx, hy, sz * hz )
			);

		}

	} else if ( def.kind === 'cone' ) {

		const radius = piece.size.radius, hh = piece.size.height / 2;

		for ( let i = 0; i < 8; i ++ ) {

			const angle = ( i / 8 ) * Math.PI * 2;
			points.push( new THREE.Vector3( Math.cos( angle ) * radius, - hh, Math.sin( angle ) * radius ) );

		}

		points.push( new THREE.Vector3( 0, hh, 0 ) );

	} else if ( def.kind === 'cylinder' ) {

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

function botBoundsXZ( bot ) {

	let minX = Infinity, maxX = - Infinity, minZ = Infinity, maxZ = - Infinity;

	for ( const piece of bot.pieces ) {

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

function shapeKey( shapeId ) {

	return `${ shapeId.index1 }:${ shapeId.generation }`;

}

function addCollider( body, piece, origin, lift, offset ) {

	const def = TYPES[ piece.type ];

	const shapeDef = b3.b3DefaultShapeDef();
	shapeDef.density = DENSITY * ARMORS[ piece.armor ].density;
	shapeDef.enableHitEvents = true;
	shapeDef.baseMaterial.friction = def.friction;
	shapeDef.baseMaterial.restitution = def.restitution;

	if ( def.kind === 'sphere' ) {

		return b3.b3CreateSphereShape( body, shapeDef, {
			center: {
				x: piece.position.x + offset.x - origin.x,
				y: piece.position.y + lift - origin.y,
				z: piece.position.z + offset.z - origin.z
			},
			radius: piece.size.radius
		} );

	}

	const flat = [];

	for ( const point of colliderLocalPoints( piece ) ) {

		_v1.copy( point ).applyQuaternion( piece.quaternion ).add( piece.position );
		flat.push( _v1.x + offset.x - origin.x, _v1.y + lift - origin.y, _v1.z + offset.z - origin.z );

	}

	const hull = b3.b3CreateHull( flat );
	const shapeId = b3.b3CreateHullShape( body, shapeDef, hull );
	hull.delete();

	return shapeId;

}

function spinRootOf( piece ) {

	let p = piece;

	while ( p !== null ) {

		if ( p.spin !== 0 ) return p;
		p = p.parent;

	}

	return null;

}

// in battle, wheels split off as their own hinged bodies too — a chassis
// on wheels rolls instead of scraping

function driveRootOf( piece ) {

	let p = piece;

	while ( p !== null ) {

		if ( p.spin !== 0 || p.type === 'wheel' ) return p;
		p = p.parent;

	}

	return null;

}

function rootPieceOf( piece ) {

	let p = piece;

	while ( p.parent !== null ) p = p.parent;

	return p;

}

// the arena — an octagon of wooden walls on the workshop floor, with a
// strip of spikes on two sides. thrown over the wall = out of the arena.

function buildArena( world ) {

	const group = new THREE.Group();

	// a painted plate marks the fight zone; thin enough that wheels
	// resting on the real floor do not visibly sink into it

	const plate = new THREE.Mesh( new THREE.CylinderGeometry( 6.7, 6.7, 0.012, 8 ), arenaFloorMaterial );
	plate.rotation.y = Math.PI / 8;
	plate.position.y = 0.006;
	plate.receiveShadow = true;
	group.add( plate );

	const arenaBody = b3.b3CreateBody( world, b3.b3DefaultBodyDef() );

	const wallShapeDef = b3.b3DefaultShapeDef();
	wallShapeDef.enableHitEvents = true;
	wallShapeDef.baseMaterial.friction = 0.5;
	wallShapeDef.baseMaterial.restitution = 0.15;

	const segmentLength = 2 * ARENA_APOTHEM * Math.tan( Math.PI / 8 ) + 0.12;
	const wallGeometry = new THREE.BoxGeometry( 0.22, WALL_HEIGHT, segmentLength );
	const spikeGeometry = new THREE.ConeGeometry( 0.07, 0.3, 10 );
	const postGeometry = new THREE.CylinderGeometry( 0.07, 0.09, 1.0, 10 );

	for ( let k = 0; k < 8; k ++ ) {

		const angle = k * Math.PI / 4;
		const cos = Math.cos( angle ), sin = Math.sin( angle );
		const hazard = k === 2 || k === 6; // the ±z walls bite

		const cx = cos * ( ARENA_APOTHEM + 0.11 );
		const cz = sin * ( ARENA_APOTHEM + 0.11 );

		const wall = new THREE.Mesh( wallGeometry, hazard ? arenaHazardMaterial : arenaWallMaterial );
		wall.position.set( cx, WALL_HEIGHT / 2, cz );
		wall.rotation.y = - angle;
		wall.castShadow = true;
		wall.receiveShadow = true;
		group.add( wall );

		// physics: the wall as a hull of its eight rotated corners

		const flat = [];

		for ( const sx of [ - 0.11, 0.11 ] )
			for ( const sy of [ 0.01, WALL_HEIGHT ] )
				for ( const sz of [ - segmentLength / 2, segmentLength / 2 ] )
					flat.push( cx + sx * cos - sz * sin, sy, cz + sx * sin + sz * cos );

		const hull = b3.b3CreateHull( flat );
		const shapeId = b3.b3CreateHullShape( arenaBody, wallShapeDef, hull );
		hull.delete();

		if ( hazard ) {

			battle.shapeMap.set( shapeKey( shapeId ), { hazard: true } );

			// a row of spikes pointing back into the arena

			for ( let j = - 2; j <= 2; j ++ ) {

				const spike = new THREE.Mesh( spikeGeometry, METALS.steel );
				const along = j * 0.85;
				spike.position.set(
					cx - cos * 0.23 - sin * along,
					0.35,
					cz - sin * 0.23 + cos * along
				);
				spike.quaternion.setFromUnitVectors( Y_AXIS, _v1.set( - cos, 0, - sin ) );
				spike.castShadow = true;
				group.add( spike );

			}

		}

		// a post on each corner

		const cornerAngle = angle + Math.PI / 8;
		const post = new THREE.Mesh( postGeometry, arenaPostMaterial );
		post.position.set( Math.cos( cornerAngle ) * 6.55, 0.5, Math.sin( cornerAngle ) * 6.55 );
		post.castShadow = true;
		group.add( post );

	}

	scene.add( group );

	return group;

}

// one fighter = one robot in the arena: bodies, joints, hp, ai state

function buildFighter( bot, world, offset, lift, index, rng ) {

	const fighter = {
		bot,
		name: bot.name,
		color: FIGHTER_COLORS[ index % FIGHTER_COLORS.length ],
		bodies: [],
		joints: [],
		states: new Map(),
		rootPiece: null,
		rootRec: null,
		damage: 0,
		totalHp: 0,
		wheelsTotal: 0,
		wheelsAlive: 0,
		mass: 0,
		alive: true,
		status: '',
		still: 0,
		slow: 0,
		hud: null,
		ai: {
			style: AI_KEYS[ bot.ai ] ?? 'brawler',
			rng,
			jitter: 0,
			jitterTimer: 0,
			diveTimer: 2 + rng() * 3,
			diving: 0,
			reversing: 0,
			orbitDir: rng() < 0.5 ? 1 : - 1
		}
	};

	for ( const piece of bot.pieces ) {

		const maxHp = pieceMaxHp( piece );
		fighter.states.set( piece, { hp: maxHp, maxHp, burning: false, burnAcc: 0, smokeAcc: 0, spreadAcc: 0, marks: [] } );
		fighter.totalHp += maxHp;
		if ( piece.type === 'wheel' ) fighter.wheelsTotal ++;

	}

	fighter.wheelsAlive = fighter.wheelsTotal;
	fighter.rootPiece = bot.pieces.find( ( piece ) => piece.parent === null ) ?? bot.pieces[ 0 ];

	// each rigid assembly becomes one body; every spinning piece (plus
	// anything built onto it) becomes its own body, joined by a motorised
	// hinge — and every wheel gets a free hinge, so chassis actually roll

	const groups = new Map();

	for ( const piece of bot.pieces ) {

		const key = driveRootOf( piece ) ?? rootPieceOf( piece );
		if ( ! groups.has( key ) ) groups.set( key, [] );
		groups.get( key ).push( piece );

	}

	const bodies = new Map();

	for ( const [ key, members ] of groups ) {

		const origin = new THREE.Vector3();

		if ( key.spin !== 0 || key.type === 'wheel' ) {

			origin.copy( key.position );

		} else {

			for ( const member of members ) origin.add( member.position );
			origin.divideScalar( members.length );

		}

		origin.add( offset );
		origin.y += lift;

		const bodyDef = b3.b3DefaultBodyDef();
		bodyDef.type = b3.b3BodyType.b3_dynamicBody;
		bodyDef.position = { x: origin.x, y: origin.y, z: origin.z };
		const body = b3.b3CreateBody( world, bodyDef );

		const rec = { body, origin, key, live: 0, destroyed: false };
		bodies.set( key, rec );
		fighter.bodies.push( rec );

		for ( const piece of members ) {

			const shapeId = addCollider( body, piece, origin, lift, offset );
			rec.live ++;

			const localPos = piece.position.clone().add( offset );
			localPos.y += lift;
			localPos.sub( origin );

			const binding = { piece, rec, localPos, localQuat: piece.quaternion.clone(), shapeId, fighter, dead: false };
			battle.bindings.push( binding );
			battle.bindingByPiece.set( piece, binding );
			battle.shapeMap.set( shapeKey( shapeId ), { piece, fighter } );

		}

		// fast weapons tunnel through thin parts without this

		if ( key.spin !== 0 ) b3.b3Body_SetBullet( body, true );

	}

	fighter.rootRec = bodies.get( driveRootOf( fighter.rootPiece ) ?? fighter.rootPiece );

	// a touch of damping steadies chassis that carry spinning mass — but a
	// bot whose root IS the spinner keeps its freewheel

	if ( fighter.rootRec.key.spin === 0 && fighter.rootRec.key.type !== 'wheel' ) {

		b3.b3Body_SetLinearDamping( fighter.rootRec.body, 0.2 );
		b3.b3Body_SetAngularDamping( fighter.rootRec.body, 1.2 );

	}

	for ( const [ key, rec ] of bodies ) {

		if ( key.spin === 0 && key.type !== 'wheel' ) continue;

		const def = TYPES[ key.type ];
		const axis = def.mountAxis.clone().applyQuaternion( key.quaternion );

		if ( key.parent === null ) {

			// a lone spinner has nothing to push against — freewheel

			if ( key.spin !== 0 ) {

				b3.b3Body_SetAngularVelocity( rec.body, {
					x: axis.x * SPIN_SPEED * key.spin,
					y: axis.y * SPIN_SPEED * key.spin,
					z: axis.z * SPIN_SPEED * key.spin
				} );

			}

			continue;

		}

		const parentRec = bodies.get( driveRootOf( key.parent ) ?? rootPieceOf( key.parent ) );

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

		// motorised for spinners; a plain free hinge for rolling wheels

		jointDef.enableMotor = key.spin !== 0;
		jointDef.motorSpeed = SPIN_SPEED * key.spin;
		jointDef.maxMotorTorque = MOTOR_TORQUE;

		const jointId = b3.b3CreateRevoluteJoint( world, jointDef );
		fighter.joints.push( { id: jointId, key, parentPiece: key.parent, destroyed: false } );

	}

	for ( const rec of fighter.bodies ) fighter.mass += b3.b3Body_GetMass( rec.body );

	return fighter;

}

function enterBattle() {

	// anyone flagged for battle with at least one piece fights

	const roster = robots.filter( ( bot ) => bot.pieces.length > 0 && bot.inBattle );

	const rng = mulberry32( battleSeed );

	// a lone bot gets a house opponent pulled from the samples

	if ( roster.length === 1 ) {

		const sample = SAMPLES[ Math.floor( rng() * SAMPLES.length ) ];
		const bots = loadRobots( [ sample ] );

		for ( const bot of bots ) {

			bot.temp = true;
			bot.inBattle = true;
			roster.push( bot );

		}

		if ( bots.length > 0 ) showToast( `house bot ${ bots[ 0 ].name } enters the arena` );

	}

	const worldDef = b3.b3DefaultWorldDef();
	worldDef.gravity = { x: 0, y: - 9.81, z: 0 };
	worldDef.hitEventThreshold = 0.8; // m/s of approach before a hit registers
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

	battle = {
		world,
		fighters: [],
		bindings: [],
		bindingByPiece: new Map(),
		shapeMap: new Map(),
		debris: [],
		deadQueue: [],
		markMeshes: [],
		rng,
		time: 0,
		over: false,
		winner: null,
		arenaGroup: null
	};

	battle.arenaGroup = buildArena( world );

	// drop the bots in a seeded ring, a touch above the floor

	let minY = Infinity;
	for ( const bot of roster ) for ( const piece of bot.pieces ) minY = Math.min( minY, pieceMinY( piece ) );
	const lift = 0.03 - Math.min( minY, 0.03 );

	const baseAngle = rng() * Math.PI * 2;

	roster.forEach( ( bot, i ) => {

		const angle = baseAngle + ( i / roster.length ) * Math.PI * 2 + ( rng() - 0.5 ) * 0.4;
		const bounds = botBoundsXZ( bot );

		const offset = new THREE.Vector3(
			Math.cos( angle ) * 3.2 - ( bounds.minX + bounds.maxX ) / 2,
			0,
			Math.sin( angle ) * 3.2 - ( bounds.minZ + bounds.maxZ ) / 2
		);

		battle.fighters.push( buildFighter( bot, world, offset, lift, i, mulberry32( battleSeed + i * 7919 ) ) );

	} );

	physicsAcc = 0;
	buildHud();
	updateBattleBar();
	document.getElementById( 'banner' ).hidden = true;

}

// the battle hud — one card per fighter

function buildHud() {

	const hud = document.getElementById( 'hud' );
	hud.textContent = '';

	for ( const fighter of battle.fighters ) {

		const card = document.createElement( 'div' );
		card.className = 'hud-card';
		card.style.setProperty( '--c', fighter.color );
		card.addEventListener( 'click', () => { focusBot = fighter.bot; updateBotsList(); } );

		const name = document.createElement( 'div' );
		name.className = 'hud-name';
		name.textContent = fighter.name;
		card.appendChild( name );

		const bar = document.createElement( 'div' );
		bar.className = 'hud-bar';
		const fill = document.createElement( 'div' );
		fill.className = 'hud-fill';
		bar.appendChild( fill );
		card.appendChild( bar );

		const status = document.createElement( 'div' );
		status.className = 'hud-status';
		card.appendChild( status );

		fighter.hud = { card, fill, status };
		hud.appendChild( card );

	}

}

function updateBattleBar() {

	document.getElementById( 'battleSeed' ).textContent = `seed ${ battleSeed } ↻`;

}

function fighterBurning( fighter ) {

	for ( const state of fighter.states.values() ) {

		if ( state.burning ) return true;

	}

	return false;

}

function updateHudFrame() {

	const remaining = Math.max( BATTLE_TIME - battle.time, 0 );
	const minutes = Math.floor( remaining / 60 );
	const seconds = Math.floor( remaining % 60 );
	document.getElementById( 'battleTime' ).textContent = `${ minutes }:${ String( seconds ).padStart( 2, '0' ) }`;

	for ( const fighter of battle.fighters ) {

		const integrity = Math.max( 0, 1 - fighter.damage / fighter.totalHp );
		fighter.hud.fill.style.width = `${ integrity * 100 }%`;
		fighter.hud.card.classList.toggle( 'dead', fighter.alive === false );

		let status = fighter.status;

		if ( fighter.alive && battle.over === false ) {

			if ( fighter.still > 2 ) status = `COUNT-OUT ${ Math.max( Math.ceil( COUNT_OUT - fighter.still ), 0 ) }`;
			else if ( fighterBurning( fighter ) ) status = 'ON FIRE 🔥';
			else status = '';

		}

		fighter.hud.status.textContent = status;

	}

}

// the driving ai — no controls, just seeded instinct

function aiStep( fighter, dt ) {

	if ( fighter.alive === false || fighter.rootRec.destroyed ) return;

	const body = fighter.rootRec.body;
	const p = b3.b3Body_GetPosition( body );

	if ( battle.over ) {

		// victory donuts

		b3.b3Body_ApplyTorque( body, { x: 0, y: fighter.mass * 8, z: 0 }, true );
		return;

	}

	const ai = fighter.ai;
	const v = b3.b3Body_GetLinearVelocity( body );

	// how long we've been crawling — pressed into someone, or beached

	fighter.slow = Math.hypot( v.x, v.z ) < 0.25 ? fighter.slow + dt : 0;

	// nearest living enemy

	let tx = 0, tz = 0, best = Infinity;

	for ( const other of battle.fighters ) {

		if ( other === fighter || other.alive === false || other.rootRec.destroyed ) continue;

		const op = b3.b3Body_GetPosition( other.rootRec.body );
		const d = ( op.x - p.x ) ** 2 + ( op.z - p.z ) ** 2;

		if ( d < best ) { best = d; tx = op.x; tz = op.z; }

	}

	let dirX, dirZ;

	if ( best === Infinity ) {

		dirX = - p.x; dirZ = - p.z; // no one left — drift to centre

	} else {

		const dx = tx - p.x, dz = tz - p.z;
		const dist = Math.max( Math.hypot( dx, dz ), 1e-4 );
		const nx = dx / dist, nz = dz / dist;

		ai.diveTimer -= dt;

		if ( ai.style === 'brawler' ) {

			dirX = nx; dirZ = nz;

		} else if ( ai.diving > 0 ) {

			// mid-lunge: straight at them

			ai.diving -= dt;
			dirX = nx; dirZ = nz;

		} else if ( ai.style === 'orbiter' ) {

			if ( ai.diveTimer <= 0 ) { ai.diving = 1.5; ai.diveTimer = 2 + ai.rng() * 2.5; }

			// circle at arm's length, drifting in or out to hold the radius

			const err = THREE.MathUtils.clamp( dist - 1.9, - 1, 1 );
			dirX = - nz * ai.orbitDir + nx * err;
			dirZ = nx * ai.orbitDir + nz * err;

		} else {

			// skirmisher: keep distance, strafe, dart in on a timer

			if ( ai.diveTimer <= 0 ) { ai.diving = 1.5; ai.diveTimer = 2 + ai.rng() * 3; }

			if ( dist < 1.1 ) { dirX = - nx; dirZ = - nz; }
			else if ( dist > 2.8 ) { dirX = nx; dirZ = nz; }
			else { dirX = - nz * ai.orbitDir; dirZ = nx * ai.orbitDir; }

		}

	}

	let len = Math.hypot( dirX, dirZ );
	if ( len < 1e-4 ) { dirX = 1; dirZ = 0; len = 1; }
	dirX /= len; dirZ /= len;

	// jammed against something? back off, then come in again for the hit —
	// the ram-reverse-ram rhythm is where the damage comes from

	if ( ai.reversing > 0 ) {

		ai.reversing -= dt;
		dirX = - dirX; dirZ = - dirZ;

	} else if ( fighter.slow > 1.2 ) {

		ai.reversing = 0.8 + ai.rng() * 0.5;

	}

	// seeded heading jitter — this is why the same bots fight differently
	// on every seed

	ai.jitterTimer -= dt;

	if ( ai.jitterTimer <= 0 ) {

		ai.jitterTimer = 0.7 + ai.rng() * 1.2;
		ai.jitter = ( ai.rng() - 0.5 ) * ( ai.style === 'brawler' ? 0.5 : 0.9 );

	}

	const cos = Math.cos( ai.jitter ), sin = Math.sin( ai.jitter );
	let sx = dirX * cos - dirZ * sin;
	let sz = dirX * sin + dirZ * cos;

	// steer back inside when the wall looms

	const rad = Math.hypot( p.x, p.z );

	if ( rad > 4.4 ) {

		let w = Math.min( ( rad - 4.4 ) / 1.6, 1 );
		w *= w;
		sx = sx * ( 1 - w ) - ( p.x / rad ) * w;
		sz = sz * ( 1 - w ) - ( p.z / rad ) * w;

		const l = Math.max( Math.hypot( sx, sz ), 1e-4 );
		sx /= l; sz /= l;

	}

	// a flipped bot claws for grip, mostly in vain — right yourself or be counted out

	const q = b3.b3Body_GetRotation( body );
	_bq1.set( q.v.x, q.v.y, q.v.z, q.s );
	const flipped = _bv1.set( 0, 1, 0 ).applyQuaternion( _bq1 ).y < - 0.3;

	// losing wheels slows you; weight drags at the top speed

	// wheel-less bots need a slippery belly (a wedge) to shove themselves
	// around — a plain wooden brick just sits there

	let scale = fighter.wheelsTotal === 0 ? 0.35 : 0.4 + 0.6 * ( fighter.wheelsAlive / fighter.wheelsTotal );
	if ( flipped ) scale *= 0.25;

	// wheels only roll one way, so a bot drives like a real robot: twist
	// the axles toward the target, push along whatever rolls

	let fx = sx, fz = sz; // wheel-less bots just scrape straight at it

	if ( fighter.wheelsAlive > 0 && flipped === false ) {

		let ax = 0, az = 0;

		for ( const piece of fighter.bot.pieces ) {

			if ( piece.type !== 'wheel' || fighter.states.has( piece ) === false ) continue;

			_bv2.set( 0, 0, 1 ).applyQuaternion( piece.mesh.quaternion );

			// axles flip sign side to side — fold them into one direction

			if ( ax * _bv2.x + az * _bv2.z < 0 ) { ax -= _bv2.x; az -= _bv2.z; }
			else { ax += _bv2.x; az += _bv2.z; }

		}

		const axleLength = Math.hypot( ax, az );

		if ( axleLength > 1e-3 ) {

			ax /= axleLength; az /= axleLength;

			// the rolling direction is ⊥ the axles, signed toward the target

			let rx = - az, rz = ax;
			if ( rx * sx + rz * sz < 0 ) { rx = - rx; rz = - rz; }

			const align = rx * sx + rz * sz; // cos of the misalignment
			const steer = rz * sx - rx * sz; // signed sin — which way to twist

			b3.b3Body_ApplyTorque( body, { x: 0, y: fighter.mass * 5 * steer, z: 0 }, true );

			fx = rx; fz = rz;
			scale *= Math.max( align, 0.2 );

		}

	}

	const maxSpeed = AI_STYLES[ ai.style ].maxSpeed * Math.pow( 45 / ( fighter.mass + 15 ), 0.25 );

	if ( v.x * fx + v.z * fz < maxSpeed ) {

		const force = DRIVE * fighter.mass * scale;
		b3.b3Body_ApplyForceToCenter( body, { x: fx * force, y: 0, z: fz * force }, true );
		fighter.dbg = { fx: Math.round( fx * force ), fz: Math.round( fz * force ), scale: Math.round( scale * 100 ) / 100 };

	} else {

		fighter.dbg = { capped: true };

	}

	// reversing didn't free it either — twist loose

	if ( flipped === false && fighter.slow > 2.5 && ai.reversing <= 0 ) {

		b3.b3Body_ApplyTorque( body, { x: 0, y: fighter.mass * 4 * ai.orbitDir, z: 0 }, true );

	}

}

// damage — every contact hit above the threshold hurts whoever got touched,
// scaled by what touched them and how fast it arrived

function processHits() {

	const count = b3.getNumContactHitEvents( eventsBuffer );
	let sounds = 0;

	for ( let i = 0; i < count; i ++ ) {

		b3.getContactHitEventAt( hitEvent, eventsBuffer, i );

		const a = battle.shapeMap.get( shapeKey( hitEvent.shapeIdA ) );
		const b = battle.shapeMap.get( shapeKey( hitEvent.shapeIdB ) );
		const speed = hitEvent.approachSpeed;
		const point = hitEvent.point;

		if ( sounds < 3 ) {

			const metal = ( a?.piece !== undefined && a.piece.armor !== 'wood' ) ||
				( b?.piece !== undefined && b.piece.armor !== 'wood' ) ||
				a?.hazard === true || b?.hazard === true;

			playHit( point, speed, metal );
			sounds ++;

		}

		if ( speed < DMG_MIN_SPEED || battle.over ) continue;

		applyHitTo( a, b, speed, point );
		applyHitTo( b, a, speed, point );

	}

}

function applyHitTo( target, source, speed, point ) {

	if ( target?.piece === undefined || target.fighter.alive === false ) return;

	const state = target.fighter.states.get( target.piece );
	if ( state === undefined || state.hp <= 0 ) return;

	let amount;

	if ( source?.piece !== undefined ) {

		const def = TYPES[ source.piece.type ];
		const armor = ARMORS[ source.piece.armor ];
		const binding = battle.bindingByPiece.get( source.piece );
		if ( binding === undefined || binding.rec.destroyed ) return;

		// hitting power grows with the mass behind the blow — a spike on a
		// heavy chassis rams harder than the same spike on a feather

		const heft = Math.cbrt( Math.max( b3.b3Body_GetMass( binding.rec.body ), 1 ) / 12 );
		const friendly = source.fighter === target.fighter ? 0.4 : 1; // your own flail still stings

		amount = 1.7 * Math.pow( speed - 1.2, 1.5 ) * def.dmg * armor.dmg * heft * friendly;

	} else if ( source?.hazard === true ) {

		amount = 1.7 * Math.pow( speed - 1.2, 1.5 ) * 3;

	} else {

		return; // floors, plain walls and dead debris are harmless

	}

	if ( TYPES[ target.piece.type ].weapon ) amount *= 0.35; // weapons are hardened

	if ( amount < 0.3 ) return;

	damagePiece( target.fighter, target.piece, amount, point );

}

function damagePiece( fighter, piece, amount, point ) {

	const state = fighter.states.get( piece );

	const applied = Math.min( state.hp, amount );
	state.hp -= applied;
	fighter.damage += applied;

	_bv1.set( point.x, point.y, point.z );
	emitSparks( _bv1, Math.min( 2 + Math.floor( amount * 0.8 ), 14 ), piece.armor !== 'wood' );

	if ( amount > 2.5 && state.marks.length < 6 ) addMark( fighter, piece, _bv1, amount );

	// battered wood catches fire

	if ( state.burning === false && ARMORS[ piece.armor ].flammable && state.hp < state.maxHp * 0.65 && battle.rng() < 0.5 ) {

		state.burning = true;

	}

	if ( state.hp <= 0 ) battle.deadQueue.push( { fighter, piece, point: _bv1.clone() } );

}

function addMark( fighter, piece, worldPoint, amount ) {

	const state = fighter.states.get( piece );

	const mark = new THREE.Mesh( markGeometry, markMaterial );
	const r = Math.min( 0.028 + amount * 0.004, 0.085 );
	mark.scale.set( r, r * 0.45, r );
	mark.rotation.set( Math.random() * 3, Math.random() * 3, Math.random() * 3 );

	_bv2.copy( worldPoint );
	piece.mesh.worldToLocal( _bv2 );
	mark.position.copy( _bv2 );

	piece.mesh.add( mark );
	state.marks.push( mark );
	battle.markMeshes.push( mark );

}

// death of a piece — it and everything bolted to it snaps off as debris

function processDeaths() {

	while ( battle.deadQueue.length > 0 ) {

		const { fighter, piece, point } = battle.deadQueue.shift();
		if ( fighter.states.has( piece ) === false ) continue; // already scrap

		destroyPieceInBattle( fighter, piece, point );

	}

	battle.bindings = battle.bindings.filter( ( binding ) => binding.dead === false );

}

function destroyPieceInBattle( fighter, piece, point ) {

	if ( piece === fighter.rootPiece ) {

		destroyFighter( fighter );
		return;

	}

	const doomed = collectSubtree( piece, fighter.bot ).filter( ( p ) => fighter.states.has( p ) );
	const doomedSet = new Set( doomed );

	// joints anchored to lost pieces die first — a freed spinner keeps
	// whirling as it flies

	for ( const joint of fighter.joints ) {

		if ( joint.destroyed ) continue;

		if ( doomedSet.has( joint.key ) || doomedSet.has( joint.parentPiece ) ) {

			try { b3.b3DestroyJoint( joint.id ); } catch ( error ) { /* body already gone */ }
			joint.destroyed = true;

		}

	}

	for ( const p of doomed ) {

		const state = fighter.states.get( p );
		fighter.damage += Math.max( state.hp, 0 ); // lost parts count as damage
		fighter.states.delete( p );
		if ( p.type === 'wheel' ) fighter.wheelsAlive --;
		breakOffPiece( p, 1.5 );

	}

	for ( const rec of fighter.bodies ) {

		if ( rec.destroyed === false && rec.live <= 0 ) {

			try { b3.b3DestroyBody( rec.body ); } catch ( error ) { /* already gone */ }
			rec.destroyed = true;

		}

	}

	playCrunch( point );
	emitExplosion( point, doomed.length > 2 );

}

function breakOffPiece( piece, kick ) {

	const binding = battle.bindingByPiece.get( piece );
	if ( binding === undefined || binding.dead ) return;

	const mesh = piece.mesh;
	const rng = battle.rng;

	// the debris keeps the velocity it had as part of the robot

	let vel = { x: 0, y: 0.5, z: 0 };

	if ( binding.rec.destroyed === false ) {

		vel = b3.b3Body_GetWorldPointVelocity( binding.rec.body, { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z } );
		try { b3.b3DestroyShape( binding.shapeId, true ); } catch ( error ) { /* already gone */ }
		binding.rec.live --;

	}

	battle.shapeMap.delete( shapeKey( binding.shapeId ) );
	binding.dead = true;
	battle.bindingByPiece.delete( piece );

	// a free body at the piece's current pose — the rotation is baked into
	// the hull so the body itself can stay unrotated

	const bodyDef = b3.b3DefaultBodyDef();
	bodyDef.type = b3.b3BodyType.b3_dynamicBody;
	bodyDef.position = { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z };
	const body = b3.b3CreateBody( battle.world, bodyDef );

	const def = TYPES[ piece.type ];
	const shapeDef = b3.b3DefaultShapeDef();
	shapeDef.density = DENSITY * ARMORS[ piece.armor ].density;
	shapeDef.enableHitEvents = true;
	shapeDef.baseMaterial.friction = 0.6;
	shapeDef.baseMaterial.restitution = 0.2;

	let shapeId;

	if ( def.kind === 'sphere' ) {

		shapeId = b3.b3CreateSphereShape( body, shapeDef, { center: { x: 0, y: 0, z: 0 }, radius: piece.size.radius } );

	} else {

		const flat = [];

		for ( const point of colliderLocalPoints( piece ) ) {

			_bv2.copy( point ).applyQuaternion( mesh.quaternion );
			flat.push( _bv2.x, _bv2.y, _bv2.z );

		}

		const hull = b3.b3CreateHull( flat );
		shapeId = b3.b3CreateHullShape( body, shapeDef, hull );
		hull.delete();

	}

	b3.b3Body_SetLinearVelocity( body, {
		x: vel.x + ( rng() - 0.5 ) * kick * 2,
		y: vel.y + rng() * kick * 1.5 + 0.5,
		z: vel.z + ( rng() - 0.5 ) * kick * 2
	} );

	b3.b3Body_SetAngularVelocity( body, {
		x: ( rng() - 0.5 ) * 8,
		y: ( rng() - 0.5 ) * 8,
		z: ( rng() - 0.5 ) * 8
	} );

	const rec = { body, origin: mesh.position.clone(), key: null, live: 1, destroyed: false };
	battle.bindings.push( { piece, rec, localPos: new THREE.Vector3(), localQuat: mesh.quaternion.clone(), shapeId, fighter: null, dead: false } );
	battle.debris.push( rec );

	// keep the junkyard bounded — the oldest chunk freezes where it lies

	if ( battle.debris.length > 40 ) {

		const old = battle.debris.shift();

		if ( old.destroyed === false ) {

			try { b3.b3DestroyBody( old.body ); } catch ( error ) { /* already gone */ }
			old.destroyed = true;

		}

	}

}

// chassis destroyed — the whole robot lets go of itself

function destroyFighter( fighter ) {

	fighter.alive = false;
	fighter.status = 'DESTROYED';

	for ( const joint of fighter.joints ) {

		if ( joint.destroyed ) continue;
		try { b3.b3DestroyJoint( joint.id ); } catch ( error ) { /* already gone */ }
		joint.destroyed = true;

	}

	_bv1.copy( fighter.rootPiece.mesh.position );

	for ( const piece of [ ...fighter.states.keys() ] ) {

		const state = fighter.states.get( piece );
		fighter.damage += Math.max( state.hp, 0 );
		fighter.states.delete( piece );
		if ( piece.type === 'wheel' ) fighter.wheelsAlive --;
		breakOffPiece( piece, 3 );

	}

	for ( const rec of fighter.bodies ) {

		if ( rec.destroyed === false && rec.live <= 0 ) {

			try { b3.b3DestroyBody( rec.body ); } catch ( error ) { /* already gone */ }
			rec.destroyed = true;

		}

	}

	playCrunch( _bv1 );
	emitExplosion( _bv1, true );
	checkOver();

}

// knocked out but still in one piece — power down and smoke

function koFighter( fighter, status ) {

	fighter.alive = false;
	fighter.status = status;

	for ( const joint of fighter.joints ) {

		if ( joint.destroyed ) continue;
		try { b3.b3DestroyJoint( joint.id ); } catch ( error ) { /* already gone */ }
		joint.destroyed = true;

	}

	for ( const rec of fighter.bodies ) {

		if ( rec.destroyed ) continue;
		b3.b3Body_SetLinearDamping( rec.body, 0.6 );
		b3.b3Body_SetAngularDamping( rec.body, 0.5 );

	}

	if ( fighter.rootRec.destroyed === false ) {

		const p = b3.b3Body_GetPosition( fighter.rootRec.body );

		for ( let i = 0; i < 6; i ++ ) {

			_bv1.set( p.x + ( Math.random() - 0.5 ) * 0.4, p.y + 0.2, p.z + ( Math.random() - 0.5 ) * 0.4 );
			emitSmoke( _bv1 );

		}

	}

	checkOver();

}

function pieceRadius( piece ) {

	const size = piece.size;
	const kind = TYPES[ piece.type ].kind;

	if ( kind === 'box' || kind === 'wedge' ) return Math.max( size.x, size.y, size.z ) / 2;
	if ( kind === 'cylinder' ) return Math.max( size.radius, size.width / 2 );
	if ( kind === 'cone' ) return Math.max( size.radius, size.height / 2 );

	return size.radius;

}

// fire — battered wood burns, burns spread along the frame, and a bot
// can burn its way right up to a knockout

function fireTick( dt ) {

	for ( const fighter of battle.fighters ) {

		for ( const [ piece, state ] of fighter.states ) {

			if ( state.burning === false ) {

				// heavily dented pieces smoulder even without flames

				if ( state.hp < state.maxHp * 0.4 ) {

					state.smokeAcc += dt;

					if ( state.smokeAcc > 0.6 ) {

						state.smokeAcc = 0;
						_bv1.copy( piece.mesh.position );
						_bv1.y += pieceRadius( piece ) * 0.5;
						emitSmoke( _bv1 );

					}

				}

				continue;

			}

			if ( fighter.alive && battle.over === false ) {

				const burn = state.maxHp * FIRE_DPS * dt;
				const applied = Math.min( state.hp, burn );
				state.hp -= applied;
				fighter.damage += applied;

				if ( state.hp <= 0 ) {

					battle.deadQueue.push( { fighter, piece, point: piece.mesh.position.clone() } );
					continue;

				}

			}

			const radius = pieceRadius( piece );

			state.burnAcc += dt;

			if ( state.burnAcc > 0.07 ) {

				state.burnAcc = 0;
				_bv1.copy( piece.mesh.position );
				_bv1.x += ( Math.random() - 0.5 ) * radius;
				_bv1.y += Math.random() * radius * 0.8;
				_bv1.z += ( Math.random() - 0.5 ) * radius;
				emitFlame( _bv1 );

			}

			state.smokeAcc += dt;

			if ( state.smokeAcc > 0.4 ) {

				state.smokeAcc = 0;
				_bv1.copy( piece.mesh.position );
				_bv1.y += radius;
				emitSmoke( _bv1 );

			}

			// flames wander to whatever wood is bolted on

			state.spreadAcc += dt;

			if ( state.spreadAcc > 2 ) {

				state.spreadAcc = 0;

				if ( battle.rng() < 0.3 ) {

					const neighbours = [];

					if ( piece.parent !== null && fighter.states.has( piece.parent ) ) neighbours.push( piece.parent );

					for ( const other of fighter.bot.pieces ) {

						if ( other.parent === piece && fighter.states.has( other ) ) neighbours.push( other );

					}

					for ( const other of neighbours ) {

						const otherState = fighter.states.get( other );

						if ( otherState.burning === false && ARMORS[ other.armor ].flammable ) {

							otherState.burning = true;
							break;

						}

					}

				}

			}

		}

	}

}

// the ways to die: shaken to bits, burned, counted out, thrown out,
// or ground down past the damage limit

function statusTick( dt ) {

	if ( battle.over ) return;

	battle.time += dt;

	for ( const fighter of battle.fighters ) {

		if ( fighter.alive === false ) continue;

		if ( fighter.damage >= fighter.totalHp * KO_DAMAGE ) {

			koFighter( fighter, 'KNOCKED OUT' );
			continue;

		}

		const p = b3.b3Body_GetPosition( fighter.rootRec.body );

		if ( Math.hypot( p.x, p.z ) > ARENA_OUT || p.y < - 0.5 ) {

			koFighter( fighter, 'OUT OF THE ARENA' );
			continue;

		}

		// controlled movement counts — turning in place is not immobile

		const v = b3.b3Body_GetLinearVelocity( fighter.rootRec.body );
		const w = b3.b3Body_GetAngularVelocity( fighter.rootRec.body );
		const moving = Math.hypot( v.x, v.y, v.z ) > 0.15 || Math.hypot( w.x, w.y, w.z ) > 0.4;
		fighter.still = moving ? 0 : fighter.still + dt;

		if ( fighter.still >= COUNT_OUT ) koFighter( fighter, 'COUNTED OUT' );

	}

	if ( battle.over === false && battle.time >= BATTLE_TIME ) {

		// the judges' decision — least damaged bot takes it

		const alive = battle.fighters.filter( ( fighter ) => fighter.alive );
		alive.sort( ( a, b ) => a.damage / a.totalHp - b.damage / b.totalHp );

		const margin = alive.length > 1
			? alive[ 1 ].damage / alive[ 1 ].totalHp - alive[ 0 ].damage / alive[ 0 ].totalHp
			: 1;

		endBattle( margin < 0.02 ? null : alive[ 0 ], "judges' decision" );

	}

}

function checkOver() {

	if ( battle.over ) return;

	const alive = battle.fighters.filter( ( fighter ) => fighter.alive );

	if ( alive.length === 1 ) endBattle( alive[ 0 ], 'last bot standing' );
	else if ( alive.length === 0 ) endBattle( null, 'mutual destruction' );

}

function endBattle( winner, how ) {

	battle.over = true;
	battle.winner = winner;

	if ( winner !== null ) winner.status = '🏆 WINNER';

	document.getElementById( 'bannerTitle' ).textContent = winner !== null ? `${ winner.name.toUpperCase() } WINS!` : "IT'S A DRAW";
	document.getElementById( 'bannerSub' ).textContent = how;
	document.getElementById( 'banner' ).hidden = false;

	playHorn();

	if ( winner !== null && winner.rootRec.destroyed === false ) {

		const p = b3.b3Body_GetPosition( winner.rootRec.body );
		emitConfetti( _bv1.set( p.x, p.y + 0.5, p.z ) );

	} else {

		emitConfetti( _bv1.set( 0, 1, 0 ) );

	}

}

function resetBattle() {

	if ( battle === null ) return;

	teardownBattle();
	enterBattle();
	refreshVisibility();
	updateBotsList();

}

function teardownBattle() {

	if ( battle === null ) return;

	b3.b3DestroyWorld( battle.world );

	for ( const mark of battle.markMeshes ) mark.removeFromParent();

	scene.remove( battle.arenaGroup );

	const geometries = new Set();
	battle.arenaGroup.traverse( ( child ) => { if ( child.geometry !== undefined ) geometries.add( child.geometry ); } );
	for ( const geometry of geometries ) geometry.dispose();

	for ( const piece of allPieces() ) {

		piece.mesh.position.copy( piece.position );
		piece.mesh.quaternion.copy( piece.quaternion );

	}

	clearParticles();
	document.getElementById( 'hud' ).textContent = '';
	document.getElementById( 'banner' ).hidden = true;

	battle = null;

}

function setMode( next ) {

	if ( next === mode ) return;

	cancelResize();
	cancelPivotDrag();
	cancelMoveDrag();
	abortRecording();

	if ( next === 'battle' ) {

		const stocked = robots.filter( ( bot ) => bot.pieces.length > 0 );

		if ( stocked.length === 0 ) {

			showToast( 'build a robot first — or grab one from Community' );
			return;

		}

		// nobody staged? everyone fights

		if ( stocked.filter( ( bot ) => bot.inBattle ).length === 0 ) {

			for ( const bot of stocked ) bot.inBattle = true;

		}

		select( null );
		initAudio(); // mode switches are user gestures, so this is allowed
		mode = 'battle';
		enterBattle();

	} else {

		teardownBattle();
		mode = 'build';

		// house bots leave with the crowd

		const temps = robots.filter( ( bot ) => bot.temp );

		for ( const bot of temps ) {

			for ( const piece of bot.pieces ) destroyPiece( piece );
			bot.pieces = [];

		}

		robots = robots.filter( ( bot ) => bot.temp === false );

		if ( robots.length === 0 ) addBot();
		else if ( robots.includes( activeBot ) === false ) setActiveBot( robots[ 0 ] );

		controls.target.set( 0, 0.4, 0 );

	}

	focusBot = null;

	document.body.classList.toggle( 'battle', mode === 'battle' );
	document.getElementById( 'buildBtn' ).classList.toggle( 'active', mode === 'build' );
	document.getElementById( 'battleBtn' ).classList.toggle( 'active', mode === 'battle' );

	refreshVisibility();
	updateBotsList();

	for ( const piece of allPieces() ) {

		if ( piece.indicator !== null ) piece.indicator.root.visible = mode === 'build';

	}

	updateToolbar();
	updateHint();
	updateBotBar();

}

function animate() {

	timer.update();
	const delta = Math.min( timer.getDelta(), 0.1 );

	if ( battle !== null ) {

		physicsAcc += delta;

		while ( physicsAcc >= TIME_STEP ) {

			for ( const fighter of battle.fighters ) aiStep( fighter, TIME_STEP );

			b3.b3World_Step( battle.world, TIME_STEP, 4 );
			physicsAcc -= TIME_STEP;

			b3.getEvents( eventsBuffer, battle.world );

			processHits();
			processDeaths();
			fireTick( TIME_STEP );
			statusTick( TIME_STEP );

		}

		for ( const binding of battle.bindings ) {

			if ( binding.rec.destroyed ) continue;

			const p = b3.b3Body_GetPosition( binding.rec.body );
			const q = b3.b3Body_GetRotation( binding.rec.body );

			_q1.set( q.v.x, q.v.y, q.v.z, q.s );

			const mesh = binding.piece.mesh;
			mesh.quaternion.copy( _q1 ).multiply( binding.localQuat );
			mesh.position.copy( binding.localPos ).applyQuaternion( _q1 ).add( _v1.set( p.x, p.y, p.z ) );

		}

		// keep the camera on the centre of the action

		const followed = [];
		const focusFighter = focusBot !== null ? battle.fighters.find( ( fighter ) => fighter.bot === focusBot ) : undefined;

		if ( focusFighter !== undefined ) {

			for ( const rec of focusFighter.bodies ) if ( rec.destroyed === false ) followed.push( rec );

		}

		if ( followed.length === 0 ) {

			const anyAlive = battle.fighters.some( ( fighter ) => fighter.alive );

			for ( const fighter of battle.fighters ) {

				if ( anyAlive && fighter.alive === false ) continue;
				for ( const rec of fighter.bodies ) if ( rec.destroyed === false ) followed.push( rec );

			}

		}

		if ( followed.length > 0 ) {

			_v2.set( 0, 0, 0 );

			for ( const rec of followed ) {

				const p = b3.b3Body_GetPosition( rec.body );
				_v2.x += p.x; _v2.y += p.y; _v2.z += p.z;

			}

			_v2.divideScalar( followed.length );
			_v2.y = Math.max( _v2.y, 0.3 );
			controls.target.lerp( _v2, 0.05 );

		}

		updateHudFrame();

	} else if ( activeBot !== null ) {

		for ( const piece of activeBot.pieces ) {

			if ( piece.indicator !== null ) piece.indicator.pivot.rotation.z += piece.spin * 3.5 * delta;

		}

	}

	updateParticles( delta );
	controls.update();
	postProcessing.render();

	if ( recording !== null && recording.finishing === false ) captureFrame();

}
