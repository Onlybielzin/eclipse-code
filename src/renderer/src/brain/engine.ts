/**
 * Three.js engine for the 3D brain view, with the look of the A30 screen
 * (~/Projects/second brain/a30/cerebro.py):
 *
 *   - the cloud turns slowly all the time (one turn every 150 s);
 *   - neurons are solid discs lit by depth (front bright, back dim), fibres are
 *     solid lines lit the same way; no bloom, no fog, no dust;
 *   - no memory or region names, only the links (hover still shows a name);
 *   - each MCP session is an "agent" ball on the sides: a query leaves the
 *     agent, reaches each memory, the memory lights up and the data spark
 *     travels back to the agent.
 *
 * With prefers-reduced-motion the cloud does not turn and frames only run
 * while something is happening.
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { R, type V3 } from './shape'
import { buildTargets, delays, rotationAt, type Formation, type Shape } from './shapes'
import { hash01, hsl, motionScale, ramp, type Motion, type Style } from './looks'

export type { Shape } from './shapes'
export type { Motion, Style } from './looks'
export type FireKind = 'search' | 'entity' | 'get' | 'save' | 'link' | 'click'

export interface EngineNode {
  id: string
  label: string
  type: string
  region: string
  importance: number
  degree: number
  pos: V3
  /** Creation time in ms (used by the "idade" style). */
  created?: number
}
export interface EngineEdge {
  a: number
  b: number
  kind: 'link' | 'supersedes' | 'synapse'
}
export interface EngineRegion {
  name: string
  pos: V3
  count: number
  members: number[]
}
export interface SceneData {
  nodes: EngineNode[]
  edges: EngineEdge[]
  regions: EngineRegion[]
}
export interface AgentOrigin {
  id: string
  label: string
}

const rgb = (r: number, g: number, b: number): V3 => [r / 255, g / 255, b / 255]

// Colours of the A30 (cerebro.py: QUENTE, COR_MEM, COR_ENT, COR_FIBRA, FUNDO).
const HOT: Record<FireKind, V3> = {
  search: rgb(115, 242, 255),
  entity: rgb(199, 140, 255),
  get: rgb(255, 199, 102),
  save: rgb(115, 255, 153),
  link: rgb(255, 128, 214),
  click: rgb(225, 232, 255),
}
const HOT_CSS: Record<FireKind, string> = {
  search: '115,242,255',
  entity: '199,140,255',
  get: '255,199,102',
  save: '115,255,153',
  link: '255,128,214',
  click: '225,232,255',
}
const BASE_MEMORY = rgb(70, 86, 168)
const BASE_ENTITY = rgb(132, 96, 240)
const EDGE_BASE: Record<EngineEdge['kind'], V3> = {
  synapse: rgb(26, 32, 70),
  link: rgb(52, 34, 108),
  supersedes: rgb(80, 26, 36),
}
const BACKGROUND = '#04050b'

const SPIN_PERIOD_MS = 150_000
const DECAY_MS = 1500
const FANOUT = 40 // first hop
const FANOUT_SECOND = 6 // second hop only leaves strong neurons
const MAX_SOURCES = 12 // hits that spread sparks; the rest only light up
const MAX_LIVE_SPARKS = 250
const SPARKS = 512 // GPU pool

// Agents (one per MCP session).
const AGENT_OUT_MS = 550
const AGENT_BACK_MS = 600
/** Route agent -> neuron -> neuron ... -> agent: at most this many stops, a short stop at each. */
const ROUTE_MAX_STOPS = 10
const ROUTE_HOLD_MS = 90
/** The whole trip (agent -> neurons -> agent) always takes this long, however many stops. */
const ROUTE_TOTAL_MS = 1200
const ROUTE_TRAIL_MS = 900 // how long the drawn path takes to fade after the comet passed
const AGENT_IDLE_MS = 5 * 60_000
const AGENT_COLOR = '225,232,255'
const AGENT_RING_IDLE = '150,160,230'
/** Slots on the A30 (2340x1080 landscape), as fractions of the height. Left/right alternate. */
const AGENT_ROWS = [0.22, 0.37, 0.52, 0.67, 0.82]
/** Rows fill from the middle out, so a few agents sit where the A30 had them. */
const AGENT_ROW_ORDER = [2, 1, 3, 0, 4]
const AGENT_SLOTS = AGENT_ROWS.length * 2
/** Default view (Centralizar). The agent balls live in 3D, on the plane facing this view. */
const HOME_CAM = new THREE.Vector3(-2.1 * R, 0.75 * R, 1.55 * R)
const HOME_DIST = HOME_CAM.length()
/** Farthest the agent balls sit from the centre, sideways (world units). */
const AGENT_SIDE_MAX = 1.7 * R
/** Energy a focused memory keeps (activity feed click) until the focus changes. */
const FOCUS_LEVEL = 0.8

const LIGHT = /* glsl */ `
  uniform float uCamDist;
  float depthLight(float z) {
    float zn = (z - (uCamDist - ${(1.3 * R).toFixed(1)})) / ${(2.6 * R).toFixed(1)};
    return clamp(1.25 - 1.05 * zn, 0.16, 1.0);
  }`

const NEURON_VERT = /* glsl */ `
  attribute float aSize; attribute float aEnergy; attribute float aBirth;
  attribute vec3 aBase; attribute vec3 aHot; attribute float aPhase;
  uniform float uScale; uniform float uPx; uniform float uTime; uniform float uTwinkle;
  varying vec3 vColor;
  ${LIGHT}
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float z = -mv.z;
    float core = clamp(0.52 * aSize * uScale / z, 2.0 * uPx, 16.0 * uPx) * aBirth;
    // Twinkle: each neuron breathes its light at its own pace; the peak is a short flash.
    float tw = 0.5 + 0.5 * sin(uTime * (0.5 + fract(aPhase * 7.13) * 1.7) + aPhase * 6.2832);
    float flash = pow(tw, 16.0);
  #ifdef GLOW
    // Only ~1 in 10 neurons ever flashes a glow, and only right at its peak.
    float spark = uTwinkle * step(0.9, fract(aPhase * 31.7)) * smoothstep(0.985, 1.0, tw) * 0.3;
    float e = max(aEnergy, spark);
    // A30: glow radius 10..52 px at 1080 lines, growing with energy and neuron size.
    float lvl = min(1.0, e * core / (4.0 * uPx));
    gl_PointSize = max(core * 2.2, (20.0 + 84.0 * lvl) * uPx) * aBirth;
    vColor = mix(aHot, aBase * 2.2, step(aEnergy, spark)) * (0.5 + e);
    // Quiet neuron: no glow at all (a 0 px point can still raster as 1 px on some GPUs).
    if (e <= 0.004) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  #else
    gl_PointSize = core * mix(1.0, 0.92 + 0.1 * tw + 0.3 * flash, uTwinkle);
    vColor = aBase * depthLight(z) * mix(1.0, 0.55 + 0.45 * tw + 0.9 * flash, uTwinkle);
  #endif
  }`
const DISC_FRAG = /* glsl */ `
  varying vec3 vColor;
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    if (dot(p, p) > 0.25) discard;
    gl_FragColor = vec4(vColor, 1.0);
  }`
const GLOW_FRAG = /* glsl */ `
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float c = 1.0 - d;
    float a = pow(c, 2.2) + 0.6 * pow(c, 8.0);
    gl_FragColor = vec4(vColor * a, 1.0);
  }`
const FIBRE_VERT = /* glsl */ `
  attribute vec3 aColor; attribute vec4 aHotMix;
  uniform float uFibre;
  varying vec3 vColor;
  ${LIGHT}
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    vColor = mix(aColor * depthLight(-mv.z) * uFibre, aHotMix.rgb, aHotMix.a);
  }`
const FIBRE_FRAG = /* glsl */ `
  varying vec3 vColor;
  void main() { gl_FragColor = vec4(vColor, 1.0); }`
const SPARK_VERT = /* glsl */ `
  attribute float aSize; attribute vec3 aColor;
  uniform float uPx;
  varying vec3 vColor;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * 18.0 * uPx;
    vColor = aColor;
  }`

interface Spark {
  slot: number
  i: number
  j: number
  t0: number
  dur: number
}
interface Pending {
  at: number
  i: number
  amount: number
  hop: number
  from: number
  kind: FireKind
}
interface Agent {
  slot: number
  label: string
  energy: number
  kind: FireKind
  last: number
  gone?: boolean
}
/** One leg of a route; -1 = the agent ball. */
interface Leg {
  a: number
  b: number
  t0: number
  dur: number
}
/** A query's path: leaves the agent, visits the hits one after another, comes back. */
interface Route {
  agent: Agent
  kind: FireKind
  legs: Leg[]
  end: number
}
export interface FocusGroup {
  ids: string[]
  kind: FireKind
}
interface AgentBump {
  at: number
  agent: Agent
  kind: FireKind
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)
const easeOutBack = (t: number) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2

/** Gradient stops of the A30 glow sprite: f^2.2 + 0.6 f^8, f = 1 - r. */
const GLOW_STOPS = [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1].map((r) => {
  const f = 1 - r
  return [r, f ** 2.2 + 0.6 * f ** 8] as const
})

function haloTexture(): THREE.Texture {
  // A30: ellipse (46% of the width, 50% of the height) of (40,34,96) at 30/255 over the background.
  const c = document.createElement('canvas')
  c.width = 512
  c.height = 256
  const g = c.getContext('2d')
  if (g) {
    g.fillStyle = BACKGROUND
    g.fillRect(0, 0, 512, 256)
    g.save()
    g.translate(256, 128)
    g.scale(0.465 * 512, 0.5 * 256)
    const grad = g.createRadialGradient(0, 0, 0, 0, 0, 1)
    grad.addColorStop(0, 'rgba(40,34,96,0.118)')
    grad.addColorStop(1, 'rgba(40,34,96,0)')
    g.fillStyle = grad
    g.beginPath()
    g.arc(0, 0, 1, 0, Math.PI * 2)
    g.fill()
    g.restore()
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

export class BrainEngine {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private cloud = new THREE.Group()
  private camera: THREE.PerspectiveCamera
  private controls: OrbitControls
  private uScale = { value: 1 }
  private uPx = { value: 1 }
  private uCamDist = { value: 1 }
  private uFibre = { value: 1 }
  private uTime = { value: 0 }
  private uTwinkle = { value: 0 }
  private halo: THREE.Texture
  /** Viewport in CSS pixels, cached in resize() so label projection never reads layout. */
  private w = 1
  private h = 1
  private pr = 1
  private scratch = new THREE.Vector3()
  private proj = { x: 0, y: 0, visible: false, z: 0 }

  private discMat: THREE.ShaderMaterial
  private glowMat: THREE.ShaderMaterial
  private fibreMat: THREE.ShaderMaterial

  private data: SceneData = { nodes: [], edges: [], regions: [] }
  private index = new Map<string, number>()
  private neighbors: { j: number; edge: number }[][] = []
  private nodeEdgeVerts: number[][] = []

  private discs?: THREE.Points
  private glows?: THREE.Points
  private lines?: THREE.LineSegments
  private sparkPoints: THREE.Points
  private sparkPos = new Float32Array(SPARKS * 3)
  private sparkSize = new Float32Array(SPARKS)
  private sparkColor = new Float32Array(SPARKS * 3)
  private freeSlots: number[] = []
  private sparks: Spark[] = []
  private sparkColorDirty = false

  private energy = new Float32Array(0)
  private active = new Set<number>()
  private pending: Pending[] = []
  private due: Pending[] = []
  private changed = new Set<number>()
  private births = new Map<number, number>()

  // Formations (A30 prototype): home = cloud, cur = what is drawn this frame.
  private home = new Float32Array(0)
  private cur = new Float32Array(0)
  private targets: Record<Formation, Float32Array> | null = null
  private delay: Float32Array = new Float32Array(0)
  private edgeNode = new Uint32Array(0)
  private shape: Shape = 'nuvem'
  private shapeT0 = 0
  private formation: Formation = 'galaxia'
  private morphS = 0
  private drawnS = -1
  private drawnFormation: Formation | null = null
  /** Shape before the continuous motion; cur = formed + motion. */
  private formed = new Float32Array(0)
  private formedDirty = false

  // Neuron variations (looks.ts).
  private motion: Motion = 'parado'
  private motionWasOn = false
  private beatAt = -1e9
  private floatPhase = new Float32Array(0)
  private style: Style = 'tipo'
  private projectOf: number[] = []
  private twinkle = false

  // Agents, drawn in 2D on top of the WebGL canvas.
  private overlay: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D | null
  private agents = new Map<string, Agent>()
  private routes: Route[] = []
  private agentBumps: AgentBump[] = []
  /** World position of each agent slot (recomputed on resize: depends on the aspect). */
  private slotPos: THREE.Vector3[] = Array.from({ length: AGENT_SLOTS }, () => new THREE.Vector3())
  private slotProj = { x: 0, y: 0, k: 1, visible: false }

  // Memories highlighted from the activity feed (stay lit until cleared).
  /** Several feed items can be highlighted at once, each in the colour of its event. */
  private focusGroups: FocusGroup[] = []
  /** Neuron -> highlight colour (a later group wins on a shared memory). */
  private focused = new Map<number, V3>()

  private hoverEl: HTMLDivElement
  private hover = -1

  private spin = 0
  private spinHold = false
  private reducedMotion: MediaQueryList
  private tween: {
    from: THREE.Vector3
    to: THREE.Vector3
    tFrom: THREE.Vector3
    tTo: THREE.Vector3
    t0: number
    dur: number
  } | null = null
  private running = false
  private rafId = 0
  private last = 0
  private dprQuery: MediaQueryList | null = null
  private raycaster = new THREE.Raycaster()
  private downAt: { x: number; y: number } | null = null
  private resizeObs: ResizeObserver

  constructor(
    private container: HTMLElement,
    private labelLayer: HTMLElement,
    private onSelect: (id: string | null) => void,
  ) {
    const w = container.clientWidth
    const h = container.clientHeight
    const pr = Math.min(window.devicePixelRatio, 2)
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    })
    this.renderer.setPixelRatio(pr)
    this.renderer.setSize(w, h)
    container.appendChild(this.renderer.domElement)

    this.halo = haloTexture()
    this.scene.background = this.halo
    this.scene.add(this.cloud)

    this.camera = new THREE.PerspectiveCamera(50, w / h, 1, 5000)
    this.camera.position.copy(HOME_CAM)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.minDistance = 0.25 * R
    this.controls.maxDistance = 7 * R
    this.controls.addEventListener('change', this.onControlsChange)
    this.controls.addEventListener('start', this.onControlsStart)

    const uniforms = {
      uScale: this.uScale,
      uPx: this.uPx,
      uCamDist: this.uCamDist,
      uFibre: this.uFibre,
      uTime: this.uTime,
      uTwinkle: this.uTwinkle,
    }
    this.discMat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: NEURON_VERT,
      fragmentShader: DISC_FRAG,
    })
    this.glowMat = new THREE.ShaderMaterial({
      uniforms,
      defines: { GLOW: '' },
      vertexShader: NEURON_VERT,
      fragmentShader: GLOW_FRAG,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    // Additive: a dim fibre fades into the background instead of drawing a dark line over the halo.
    this.fibreMat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: FIBRE_VERT,
      fragmentShader: FIBRE_FRAG,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    })

    // Spark pool (pulses travelling along fibres).
    for (let i = SPARKS - 1; i >= 0; i--) this.freeSlots.push(i)
    const sg = new THREE.BufferGeometry()
    sg.setAttribute('position', new THREE.BufferAttribute(this.sparkPos, 3))
    sg.setAttribute('aSize', new THREE.BufferAttribute(this.sparkSize, 1))
    sg.setAttribute('aColor', new THREE.BufferAttribute(this.sparkColor, 3))
    this.sparkPoints = new THREE.Points(
      sg,
      new THREE.ShaderMaterial({
        uniforms,
        vertexShader: SPARK_VERT,
        fragmentShader: GLOW_FRAG,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    )
    this.sparkPoints.frustumCulled = false
    this.sparkPoints.renderOrder = 3
    this.cloud.add(this.sparkPoints)

    this.overlay = document.createElement('canvas')
    this.overlay.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;pointer-events:none'
    container.appendChild(this.overlay)
    this.ctx = this.overlay.getContext('2d')

    this.hoverEl = document.createElement('div')
    this.hoverEl.className = 'n-label hover'
    this.hoverEl.style.display = 'none'
    labelLayer.appendChild(this.hoverEl)

    const el = this.renderer.domElement
    el.addEventListener('pointermove', this.onMove)
    el.addEventListener('pointerdown', this.onDown)
    el.addEventListener('pointerup', this.onUp)
    el.addEventListener('pointerleave', this.onLeave)

    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    this.reducedMotion.addEventListener('change', this.kick)
    document.addEventListener('visibilitychange', this.onVisibility)

    this.resizeObs = new ResizeObserver(this.resize)
    this.resizeObs.observe(container)
    this.watchDpr()
    this.resize()
  }

  // ── Data ──────────────────────────────────────────────────────────────────
  setData(data: SceneData) {
    const prevEnergy = new Map<string, number>()
    for (const i of this.active) prevEnergy.set(this.data.nodes[i]!.id, this.energy[i]!)
    this.pending = []
    this.births.clear()
    this.routes = []
    this.agentBumps = []
    this.hover = -1
    this.hoverEl.style.display = 'none'

    this.data = data
    const n = data.nodes.length
    this.index = new Map(data.nodes.map((node, i) => [node.id, i]))
    this.energy = new Float32Array(n)
    this.active.clear()
    for (const [id, e] of prevEnergy) {
      const i = this.index.get(id)
      if (i !== undefined) {
        this.energy[i] = e
        this.active.add(i)
      }
    }

    this.focused = this.focusMap(this.focusGroups)
    for (const i of this.focused.keys()) {
      this.energy[i] = Math.max(this.energy[i]!, FOCUS_LEVEL)
      this.active.add(i)
    }

    // Neurons: one geometry, drawn twice (solid disc + additive glow).
    if (this.discs) {
      this.cloud.remove(this.discs)
      this.discs.geometry.dispose()
    }
    if (this.glows) this.cloud.remove(this.glows)
    const pos = new Float32Array(n * 3)
    this.home = new Float32Array(n * 3)
    data.nodes.forEach((node, i) => this.home.set(node.pos, i * 3))
    this.cur = new Float32Array(this.home)
    this.formed = new Float32Array(this.home)
    this.formedDirty = true
    this.floatPhase = new Float32Array(n * 3)
    for (let k = 0; k < n * 3; k++)
      this.floatPhase[k] = hash01(`${data.nodes[Math.floor(k / 3)]!.id}#${k % 3}`) * Math.PI * 2
    const projects = new Map<string, number>()
    const region = data.nodes.map((node) => {
      if (node.type === 'entity' || node.region === 'global') return -1
      if (!projects.has(node.region)) projects.set(node.region, projects.size)
      return projects.get(node.region)!
    })
    this.targets = buildTargets({
      home: this.home,
      entity: data.nodes.map((x) => x.type === 'entity'),
      region,
    })
    this.delay = delays(n)
    this.drawnS = -1
    const size = new Float32Array(n)
    const base = new Float32Array(n * 3)
    const hot = new Float32Array(n * 3)
    const birth = new Float32Array(n).fill(1)
    const phase = new Float32Array(n)
    data.nodes.forEach((node, i) => {
      pos.set(node.pos, i * 3)
      hot.set(this.focused.get(i) ?? HOT.search, i * 3)
      phase[i] = hash01(node.id)
    })
    this.projectOf = region
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1))
    g.setAttribute('aBase', new THREE.BufferAttribute(base, 3))
    g.setAttribute('aHot', new THREE.BufferAttribute(hot, 3))
    g.setAttribute('aEnergy', new THREE.BufferAttribute(this.energy, 1))
    g.setAttribute('aBirth', new THREE.BufferAttribute(birth, 1))
    g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1))
    g.computeBoundingSphere()
    this.discs = new THREE.Points(g, this.discMat)
    this.discs.frustumCulled = false
    this.discs.renderOrder = 1
    this.glows = new THREE.Points(g, this.glowMat)
    this.glows.renderOrder = 2
    this.glows.frustumCulled = false
    this.cloud.add(this.discs, this.glows)
    this.applyStyle()

    // Fibres.
    if (this.lines) {
      this.cloud.remove(this.lines)
      this.lines.geometry.dispose()
    }
    const m = data.edges.length
    const lpos = new Float32Array(m * 6)
    const lcol = new Float32Array(m * 6)
    const lhot = new Float32Array(m * 8)
    this.neighbors = Array.from({ length: n }, () => [])
    this.nodeEdgeVerts = Array.from({ length: n }, () => [])
    data.edges.forEach((e, k) => {
      lpos.set(data.nodes[e.a]!.pos, k * 6)
      lpos.set(data.nodes[e.b]!.pos, k * 6 + 3)
      const c = EDGE_BASE[e.kind]
      lcol.set(c, k * 6)
      lcol.set(c, k * 6 + 3)
      this.neighbors[e.a]!.push({ j: e.b, edge: k })
      this.neighbors[e.b]!.push({ j: e.a, edge: k })
      this.nodeEdgeVerts[e.a]!.push(k * 2)
      this.nodeEdgeVerts[e.b]!.push(k * 2 + 1)
    })
    // Real links first so a capped fan-out keeps the meaningful fibres.
    for (const list of this.neighbors)
      list.sort(
        (p, q) =>
          Number(data.edges[p.edge]!.kind === 'synapse') -
          Number(data.edges[q.edge]!.kind === 'synapse'),
      )
    const lg = new THREE.BufferGeometry()
    lg.setAttribute('position', new THREE.BufferAttribute(lpos, 3))
    lg.setAttribute('aColor', new THREE.BufferAttribute(lcol, 3))
    lg.setAttribute('aHotMix', new THREE.BufferAttribute(lhot, 4))
    this.edgeNode = new Uint32Array(m * 2)
    data.edges.forEach((e, k) => {
      this.edgeNode[k * 2] = e.a
      this.edgeNode[k * 2 + 1] = e.b
    })
    this.lines = new THREE.LineSegments(lg, this.fibreMat)
    this.lines.frustumCulled = false
    this.lines.renderOrder = 0
    this.cloud.add(this.lines)

    this.kick()
  }

  // ── Activation ────────────────────────────────────────────────────────────
  /**
   * Lights the given memories. With an agent, one comet leaves the agent ball,
   * visits the hits one after another (nearest next) and comes back.
   */
  fire(ids: string[], kind: FireKind, opts: { birth?: boolean; agent?: AgentOrigin } = {}) {
    const t = performance.now()
    const agent = opts.agent ? this.agentFor(opts.agent, t) : null
    const hits = ids.map((id) => this.index.get(id)).filter((i): i is number => i !== undefined)
    if (hits.length === 0) return
    if (opts.birth) {
      this.births.set(hits[0]!, agent ? t + AGENT_OUT_MS : t)
      ;(this.discs!.geometry.attributes.aBirth as THREE.BufferAttribute).setX(hits[0]!, 0)
    }
    if (agent) {
      this.route(agent, kind, hits, t)
      this.kick()
      return
    }
    this.beatAt = t
    const step = hits.length <= 12 ? 110 : 1300 / hits.length
    hits.forEach((i, k) => {
      const amount = Math.max(0.55, 1 - k * 0.05)
      const hop = k < MAX_SOURCES ? 0 : 2
      this.pending.push({ at: t + k * step, i, amount, hop, from: -1, kind })
    })
    this.kick()
  }

  private route(agent: Agent, kind: FireKind, hits: number[], t: number) {
    // Nearest-next order from the best hit, so the comet doesn't zigzag across the cloud.
    const left = hits.slice(0, ROUTE_MAX_STOPS)
    const stops = [left.shift()!]
    const c = this.cur
    while (left.length > 0) {
      const p = stops[stops.length - 1]
      let best = 0
      let bestD = Infinity
      left.forEach((q, k) => {
        const d =
          (c[p! * 3]! - c[q * 3]!) ** 2 +
          (c[p! * 3 + 1]! - c[q * 3 + 1]!) ** 2 +
          (c[p! * 3 + 2]! - c[q * 3 + 2]!) ** 2
        if (d < bestD) {
          bestD = d
          best = k
        }
      })
      stops.push(left.splice(best, 1)[0]!)
    }
    // Natural durations first (longer hop = longer leg), then everything is
    // squeezed or stretched so the whole trip always takes ROUTE_TOTAL_MS.
    const legs: Leg[] = []
    const arrivals: number[] = []
    let at = 0
    legs.push({ a: -1, b: stops[0]!, t0: at, dur: AGENT_OUT_MS })
    at += AGENT_OUT_MS
    arrivals.push(at)
    for (let k = 1; k < stops.length; k++) {
      const p = stops[k - 1]
      const q = stops[k]
      const d = Math.hypot(
        c[p! * 3]! - c[q! * 3]!,
        c[p! * 3 + 1]! - c[q! * 3 + 1]!,
        c[p! * 3 + 2]! - c[q! * 3 + 2]!,
      )
      const dur = Math.min(520, 170 + d * 2.4)
      at += ROUTE_HOLD_MS
      legs.push({ a: p!, b: q!, t0: at, dur })
      at += dur
      arrivals.push(at)
    }
    at += ROUTE_HOLD_MS
    legs.push({ a: stops[stops.length - 1]!, b: -1, t0: at, dur: AGENT_BACK_MS })
    at += AGENT_BACK_MS
    const f = ROUTE_TOTAL_MS / at
    for (const l of legs) {
      l.t0 = t + l.t0 * f
      l.dur *= f
    }
    stops.forEach((i, k) => {
      this.pending.push({
        at: t + arrivals[k]! * f,
        i,
        amount: Math.max(0.6, 1 - k * 0.04),
        hop: 2,
        from: -1,
        kind,
      })
    })
    this.beatAt = t + arrivals[0]! * f
    if (this.births.has(stops[0]!)) this.births.set(stops[0]!, this.beatAt) // a new memory grows when the comet lands
    at = t + ROUTE_TOTAL_MS
    this.agentBumps.push({ at, agent, kind })
    // Hits beyond the route only light up softly while the comet travels.
    const extra = hits.slice(ROUTE_MAX_STOPS)
    extra.forEach((i, k) => {
      this.pending.push({
        at: t + arrivals[0]! * f + (k / extra.length) * (ROUTE_TOTAL_MS / 2),
        i,
        amount: 0.45,
        hop: 2,
        from: -1,
        kind,
      })
    })
    this.routes.push({ agent, kind, legs, end: at })
  }

  /** Flies the camera to the memories (the highlight is setHighlights). */
  focus(ids: string[]) {
    const pts = ids.map((id) => this.index.get(id)).filter((i): i is number => i !== undefined)
    if (pts.length === 0) return
    // The cloud stops turning while a cluster is in focus; "Centralizar" resumes.
    this.spinHold = true
    this.cloud.updateMatrixWorld()
    const world = pts.map((i) =>
      new THREE.Vector3(this.cur[i * 3], this.cur[i * 3 + 1], this.cur[i * 3 + 2]).applyMatrix4(
        this.cloud.matrixWorld,
      ),
    )
    const c = new THREE.Vector3()
    for (const p of world) c.add(p)
    c.divideScalar(world.length)
    let spread = 0
    for (const p of world) spread = Math.max(spread, c.distanceTo(p))
    const dir =
      c.lengthSq() > 1
        ? c.clone().normalize()
        : this.camera.position.clone().sub(this.controls.target).normalize()
    const dist = Math.max(0.55 * R, spread * 2.6)
    this.startTween(c.clone().add(dir.multiplyScalar(dist)), c)
  }

  /** Cloud, one formation (goes and stays) or rodízio (cycles through all of them). */
  setShape(shape: Shape) {
    if (shape === this.shape) return
    this.shape = shape
    this.shapeT0 = performance.now()
    this.kick()
  }

  /** Continuous motion of the points (on top of the shape). */
  setMotion(motion: Motion) {
    if (motion === this.motion) return
    this.motion = motion
    this.kick()
  }

  /** What colour and size of the neurons show. */
  setStyle(style: Style) {
    if (style === this.style) return
    this.style = style
    this.applyStyle()
    this.kick()
  }

  /** Neurons twinkle softly, each at its own pace. */
  setTwinkle(on: boolean) {
    this.twinkle = on
    this.kick()
  }

  /**
   * Memories that stay lit (feed items the user clicked), each group in the
   * colour of its event. Memories that leave the set fade out like after a query.
   */
  setHighlights(groups: FocusGroup[]) {
    for (const i of this.focused.keys()) this.active.add(i)
    this.focusGroups = groups
    this.focused = this.focusMap(groups)
    const hot = this.discs?.geometry.attributes.aHot as THREE.BufferAttribute | undefined
    for (const [i, c] of this.focused) {
      this.energy[i] = Math.max(this.energy[i]!, FOCUS_LEVEL)
      hot?.setXYZ(i, ...c)
      this.active.add(i)
    }
    if (hot) hot.needsUpdate = true
    this.kick()
  }

  resetView() {
    this.spinHold = false
    this.startTween(HOME_CAM.clone(), new THREE.Vector3(0, 0, 0))
  }

  dispose() {
    this.running = false
    cancelAnimationFrame(this.rafId)
    this.resizeObs.disconnect()
    this.dprQuery?.removeEventListener('change', this.onDprChange)
    this.dprQuery = null
    this.reducedMotion.removeEventListener('change', this.kick)
    document.removeEventListener('visibilitychange', this.onVisibility)

    const el = this.renderer.domElement
    el.removeEventListener('pointermove', this.onMove)
    el.removeEventListener('pointerdown', this.onDown)
    el.removeEventListener('pointerup', this.onUp)
    el.removeEventListener('pointerleave', this.onLeave)
    this.controls.removeEventListener('change', this.onControlsChange)
    this.controls.removeEventListener('start', this.onControlsStart)
    this.controls.dispose()

    this.discs?.geometry.dispose()
    this.lines?.geometry.dispose()
    this.discMat.dispose()
    this.glowMat.dispose()
    this.fibreMat.dispose()
    this.sparkPoints.geometry.dispose()
    ;(this.sparkPoints.material as THREE.Material).dispose()
    this.halo.dispose()
    this.scene.clear()

    this.renderer.dispose()
    this.renderer.forceContextLoss()
    el.remove()
    this.overlay.remove()
    this.labelLayer.replaceChildren()
  }

  // ── Internals ─────────────────────────────────────────────────────────────
  private get spinning() {
    return !this.reducedMotion.matches && !this.spinHold
  }

  private focusMap(groups: FocusGroup[]) {
    const m = new Map<number, V3>()
    for (const g of groups) {
      for (const id of g.ids) {
        const i = this.index.get(id)
        if (i !== undefined) m.set(i, HOT[g.kind])
      }
    }
    return m
  }

  private agentFor(origin: AgentOrigin, now: number): Agent {
    let a = this.agents.get(origin.id)
    if (!a) {
      const used = new Set([...this.agents.values()].map((x) => x.slot))
      let slot = Array.from({ length: AGENT_SLOTS }, (_, s) => s).find((s) => !used.has(s))
      if (slot === undefined) {
        // Every slot taken: the session idle the longest gives its place.
        let oldest: string | null = null
        for (const [id, x] of this.agents)
          if (!oldest || x.last < this.agents.get(oldest)!.last) oldest = id
        const old = this.agents.get(oldest!)!
        old.gone = true
        slot = old.slot
        this.agents.delete(oldest!)
      }
      a = { slot, label: '', energy: 0, kind: 'search', last: now }
      this.agents.set(origin.id, a)
    }
    const label = origin.label || 'sessão'
    a.label = label.length > 30 ? `${label.slice(0, 29).trimEnd()}…` : label
    a.last = now
    return a
  }

  private startTween(to: THREE.Vector3, tTo: THREE.Vector3) {
    this.tween = {
      from: this.camera.position.clone(),
      to,
      tFrom: this.controls.target.clone(),
      tTo,
      t0: performance.now(),
      dur: 1100,
    }
    this.kick()
  }

  private spawnSpark(i: number, j: number, dur: number, color: V3) {
    if (this.sparks.length >= MAX_LIVE_SPARKS) return false
    const slot = this.freeSlots.pop()
    if (slot === undefined) return false
    this.sparks.push({ slot, i, j, t0: performance.now(), dur })
    this.sparkColor.set(color, slot * 3)
    this.sparkColorDirty = true
    return true
  }

  /** Janela oculta: sem quadros até voltar (visibilitychange). */
  private onVisibility = () => {
    if (document.hidden) {
      this.running = false
      cancelAnimationFrame(this.rafId)
    } else this.kick()
  }

  private kick = () => {
    if (this.running || document.hidden) return
    this.running = true
    this.last = performance.now()
    this.rafId = requestAnimationFrame(this.frame)
  }

  private frame = () => {
    if (!this.running) return
    const now = performance.now()
    const dt = Math.min(now - this.last, 50)
    this.last = now
    let busy = false
    const geo = this.discs?.geometry
    const changed = this.changed
    changed.clear()
    let hotDirty = false

    // 0. Slow turn, always on (A30: one turn every 150 s).
    if (this.spinning) {
      busy = true
      this.spin = (this.spin + (dt / SPIN_PERIOD_MS) * Math.PI * 2) % (Math.PI * 2)
      this.cloud.rotation.y = this.spin
    }

    // 0b. Formations, then the continuous motion on top.
    if (this.stepShape(now, dt)) busy = true
    if (this.stepMotion(now)) busy = true
    const twinkle = this.twinkle && !this.reducedMotion.matches
    this.uTwinkle.value = twinkle ? 1 : 0
    if (twinkle) {
      busy = true
      this.uTime.value = (now / 1000) % 3600
    }

    // 1. Deliver spikes due now, propagate to neighbours with a travelling spark.
    if (this.pending.length > 0) {
      busy = true
      const pending = this.pending
      const due = this.due
      due.length = 0
      let keep = 0
      for (let k = 0; k < pending.length; k++) {
        const p = pending[k]
        if (p!.at <= now) due.push(p!)
        else pending[keep++] = p!
      }
      pending.length = keep
      for (const p of due) {
        if (p.amount >= this.energy[p.i]!) {
          this.energy[p.i] = p.amount
          if (geo) {
            const c = HOT[p.kind]
            ;(geo.attributes.aHot as THREE.BufferAttribute).setXYZ(p.i, c[0], c[1], c[2])
            hotDirty = true
          }
        }
        this.active.add(p.i)
        changed.add(p.i)
        if (p.hop < 2 && p.amount > 0.2) {
          const limit = p.hop === 0 ? FANOUT : FANOUT_SECOND
          let fan = 0
          for (const { j } of this.neighbors[p.i]!) {
            if (j === p.from) continue
            if (fan >= limit) break
            const c = this.cur
            const dist = Math.hypot(
              c[p.i * 3]! - c[j * 3]!,
              c[p.i * 3 + 1]! - c[j * 3 + 1]!,
              c[p.i * 3 + 2]! - c[j * 3 + 2]!,
            )
            const dur = 280 + dist * 4.5
            if (!this.spawnSpark(p.i, j, dur, HOT[p.kind])) break
            fan++
            this.pending.push({
              at: now + dur,
              i: j,
              amount: p.amount * 0.45,
              hop: p.hop + 1,
              from: p.i,
              kind: p.kind,
            })
          }
        }
      }
      due.length = 0
    }

    // 2. Decay.
    if (this.active.size > 0) {
      busy = true
      const k = Math.exp(-dt / DECAY_MS)
      for (const i of this.active) {
        this.energy[i]! *= k
        const fc = this.focused.get(i)
        if (fc && this.energy[i]! <= FOCUS_LEVEL) {
          // Focused from the feed: rests lit, in the focus colour, without animating.
          this.energy[i] = FOCUS_LEVEL
          this.active.delete(i)
          if (geo) {
            ;(geo.attributes.aHot as THREE.BufferAttribute).setXYZ(i, ...fc)
            hotDirty = true
          }
        } else if (this.energy[i]! < 0.004) {
          this.energy[i] = 0
          this.active.delete(i)
        }
        changed.add(i)
      }
    }

    // 3. Births (a memory just created grows in).
    if (this.births.size > 0 && geo) {
      busy = true
      const attr = geo.attributes.aBirth as THREE.BufferAttribute
      for (const [i, t0] of this.births) {
        const t = Math.max(0, Math.min(1, (now - t0) / 1300))
        attr.setX(i, t >= 1 ? 1 : Math.max(0, easeOutBack(t)))
        if (t >= 1) this.births.delete(i)
      }
      attr.needsUpdate = true
    }

    // 4. Push energy into the GPU buffers (neurons + their fibres).
    if (changed.size > 0 && geo && this.lines) {
      ;(geo.attributes.aEnergy as THREE.BufferAttribute).needsUpdate = true
      if (hotDirty) (geo.attributes.aHot as THREE.BufferAttribute).needsUpdate = true
      const mix = this.lines.geometry.attributes.aHotMix as THREE.BufferAttribute
      const hot = geo.attributes.aHot as THREE.BufferAttribute
      for (const i of changed) {
        const e = this.energy[i]
        for (const v of this.nodeEdgeVerts[i]!)
          mix.setXYZW(v, hot.getX(i), hot.getY(i), hot.getZ(i), e! * 0.75)
      }
      mix.needsUpdate = true
    }

    // 5. Sparks along the fibres.
    if (this.sparks.length > 0) {
      busy = true
      const sparks = this.sparks
      for (let k = sparks.length - 1; k >= 0; k--) {
        const s = sparks[k]
        const t = (now - s!.t0) / s!.dur
        if (t >= 1) {
          this.sparkSize[s!.slot] = 0
          this.freeSlots.push(s!.slot)
          sparks[k] = sparks[sparks.length - 1]!
          sparks.pop()
          continue
        }
        const u = easeInOut(t)
        const c = this.cur
        for (let d = 0; d < 3; d++)
          this.sparkPos[s!.slot * 3 + d] =
            c[s!.i * 3 + d]! + (c[s!.j * 3 + d]! - c[s!.i * 3 + d]!) * u
        this.sparkSize[s!.slot] = 1
      }
      const sg = this.sparkPoints.geometry
      sg.attributes.position!.needsUpdate = true
      ;(sg.attributes.aSize as THREE.BufferAttribute).needsUpdate = true
      if (this.sparkColorDirty) {
        ;(sg.attributes.aColor as THREE.BufferAttribute).needsUpdate = true
        this.sparkColorDirty = false
      }
    }

    // 6. Camera.
    if (this.tween) {
      busy = true
      const t = Math.min(1, (now - this.tween.t0) / this.tween.dur)
      const u = easeInOut(t)
      this.camera.position.lerpVectors(this.tween.from, this.tween.to, u)
      this.controls.target.lerpVectors(this.tween.tFrom, this.tween.tTo, u)
      if (t >= 1) this.tween = null
    }
    if (this.controls.update()) busy = true
    this.uCamDist.value = this.camera.position.length()

    this.renderer.render(this.scene, this.camera)

    // 7. Agents and the hover label (2D, after the cloud moved this frame).
    if (this.updateAgents(now, dt)) busy = true
    this.cloud.updateMatrixWorld()
    this.drawOverlay(now)
    this.placeHover()

    if (busy) this.rafId = requestAnimationFrame(this.frame)
    else this.running = false
  }

  /** Returns true while an agent still has something animating. */
  private updateAgents(now: number, dt: number): boolean {
    let busy = false
    if (this.agentBumps.length > 0) {
      busy = true
      this.agentBumps = this.agentBumps.filter((b) => {
        if (b.at > now) return true
        b.agent.energy = Math.min(1.6, b.agent.energy + 0.35)
        b.agent.kind = b.kind
        return false
      })
    }
    const k = Math.exp(-dt / 900)
    for (const [id, a] of this.agents) {
      if (now - a.last > AGENT_IDLE_MS) {
        a.gone = true
        this.agents.delete(id)
        busy = true
        continue
      }
      a.energy *= k
      if (a.energy > 0.01) busy = true
    }
    if (this.routes.length > 0) {
      busy = true
      this.routes = this.routes.filter((r) => now < r.end + ROUTE_TRAIL_MS && !r.agent.gone)
    }
    return busy
  }

  /**
   * Agent slots in 3D: left/right alternating rows (A30 layout) on the plane
   * that faces the default view. Like the neurons, they move and scale with
   * the camera, so zooming in leaves them behind.
   */
  private placeSlots() {
    const forward = HOME_CAM.clone().negate().normalize()
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize()
    const up = new THREE.Vector3().crossVectors(right, forward)
    const halfH = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * HOME_DIST
    const side = Math.min(AGENT_SIDE_MAX, 0.78 * halfH * this.camera.aspect)
    this.slotPos.forEach((p, slot) => {
      const row = AGENT_ROWS[AGENT_ROW_ORDER[slot >> 1]!]!
      const x = slot % 2 === 1 ? side : -side
      p.copy(right)
        .multiplyScalar(x)
        .addScaledVector(up, (1 - 2 * row) * halfH)
    })
  }

  /** Slot on screen (CSS px) and its size factor. Returns a shared object: read it before the next call. */
  private slotXY(slot: number) {
    const o = this.slotProj
    const p = this.slotPos[slot]
    const depth = this.camera.position.distanceTo(p!)
    const v = this.scratch.copy(p!).project(this.camera)
    o.x = (v.x * 0.5 + 0.5) * this.w
    o.y = (-v.y * 0.5 + 0.5) * this.h
    o.visible = v.z < 1 && v.z > -1
    o.k = this.uiScale() * Math.min(3, Math.max(0.15, HOME_DIST / Math.max(1, depth)))
    return o
  }

  private uiScale() {
    return Math.max(0.5, Math.min(1, this.h / 1080))
  }

  private glow(x: number, y: number, r: number, color: string, intensity: number) {
    const g = this.ctx!
    const grad = g.createRadialGradient(x, y, 0, x, y, r)
    for (const [at, a] of GLOW_STOPS)
      grad.addColorStop(at, `rgba(${color},${Math.min(1, a * intensity)})`)
    g.fillStyle = grad
    g.beginPath()
    g.arc(x, y, r, 0, Math.PI * 2)
    g.fill()
  }

  /** Screen point of a route end: -1 = the agent ball, else a neuron. */
  private endXY(agent: Agent, i: number): [number, number] {
    if (i < 0) {
      const a = this.slotXY(agent.slot)
      return [a.x, a.y]
    }
    const p = this.projectNode(i)
    return [p.x, p.y]
  }

  /** Where the comet is at time t (null before it leaves / after it is back). */
  private routeAt(r: Route, t: number): [number, number] | null {
    if (t < r.legs[0]!.t0 || t > r.end) return null
    for (let k = r.legs.length - 1; k >= 0; k--) {
      const l = r.legs[k]
      if (t < l!.t0) continue
      if (t >= l!.t0 + l!.dur) return this.endXY(r.agent, l!.b) // resting at the stop
      const u = easeInOut((t - l!.t0) / l!.dur)
      const [x0, y0] = this.endXY(r.agent, l!.a)
      const [x1, y1] = this.endXY(r.agent, l!.b)
      return [x0 + (x1 - x0) * u, y0 + (y1 - y0) * u]
    }
    return null
  }

  private drawRoute(r: Route, now: number, k: number) {
    const g = this.ctx!
    const color = HOT_CSS[r.kind]
    // Path already travelled: each leg fades after the comet leaves it.
    for (const l of r.legs) {
      if (now < l.t0) break
      const done = Math.min(1, (now - l.t0) / l.dur)
      const age = now - (l.t0 + l.dur)
      const alpha = age <= 0 ? 0.7 : 0.7 * Math.max(0, 1 - age / ROUTE_TRAIL_MS)
      if (alpha <= 0.01) continue
      const [x0, y0] = this.endXY(r.agent, l.a)
      const [x1, y1] = this.endXY(r.agent, l.b)
      const u = easeInOut(done)
      g.strokeStyle = `rgba(${color},${alpha})`
      g.lineWidth = Math.max(1.2, 2 * k)
      g.beginPath()
      g.moveTo(x0, y0)
      g.lineTo(x0 + (x1 - x0) * u, y0 + (y1 - y0) * u)
      g.stroke()
    }
    // Arrival: a ring opens on each neuron the comet reaches.
    for (const l of r.legs) {
      if (l.b < 0) continue
      const u = (now - (l.t0 + l.dur)) / 500
      if (u < 0 || u > 1) continue
      const [x, y] = this.endXY(r.agent, l.b)
      g.strokeStyle = `rgba(${color},${0.8 * (1 - u) ** 1.5})`
      g.lineWidth = Math.max(1, 2 * k * (1 - u) + 0.6)
      g.beginPath()
      g.arc(x, y, (5 + 26 * easeInOut(u)) * k, 0, Math.PI * 2)
      g.stroke()
      if (u < 0.35) this.glow(x, y, 26 * k, color, 1 - u / 0.35)
    }
    // Comet: tail of fading glows behind the head.
    const TAIL = 14
    for (let s = TAIL; s >= 1; s--) {
      const p = this.routeAt(r, now - s * 16)
      if (!p) continue
      const f = 1 - s / (TAIL + 1)
      this.glow(p[0], p[1], (4 + 10 * f) * k, color, 0.15 + 0.6 * f * f)
    }
    const head = this.routeAt(r, now)
    if (head) {
      this.glow(head[0], head[1], 20 * k, color, 1)
      g.fillStyle = 'rgba(255,255,255,0.95)'
      g.beginPath()
      g.arc(head[0], head[1], 3.2 * k, 0, Math.PI * 2)
      g.fill()
    }
  }

  /** Ring around each memory focused from the feed, so they stand out from the rest. */
  private drawFocus(k: number) {
    if (this.focused.size === 0) return
    const g = this.ctx!
    g.globalCompositeOperation = 'lighter'
    g.lineWidth = Math.max(1.2, 2 * k)
    for (const [i, c] of this.focused) {
      const p = this.projectNode(i)
      if (!p.visible) continue
      g.strokeStyle = `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},0.85)`
      g.beginPath()
      g.arc(p.x, p.y, Math.max(9, 16 * k), 0, Math.PI * 2)
      g.stroke()
    }
    g.globalCompositeOperation = 'source-over'
  }

  private drawOverlay(now: number) {
    const g = this.ctx
    if (!g) return
    g.setTransform(this.pr, 0, 0, this.pr, 0, 0)
    g.clearRect(0, 0, this.w, this.h)
    const k = this.uiScale()
    this.drawFocus(k)
    if (this.agents.size === 0) return

    // Routes: fading path behind, comet with a tail on the head.
    g.globalCompositeOperation = 'lighter'
    g.lineCap = 'round'
    for (const r of this.routes) this.drawRoute(r, now, k)

    // Agent balls: glow, solid core, thin ring, name below.
    for (const a of this.agents.values()) {
      const { x, y, k, visible } = this.slotXY(a.slot)
      if (!visible) continue
      const lit = a.energy >= 0.05
      const level = Math.min(8, Math.floor(1 + a.energy * 5))
      g.globalCompositeOperation = 'lighter'
      this.glow(x, y, 40 * k, lit ? HOT_CSS[a.kind] : AGENT_COLOR, 0.5 + level / 8)
      this.glow(x, y, 22 * k, AGENT_COLOR, 0.5 + 7 / 8)
      g.globalCompositeOperation = 'source-over'
      g.fillStyle = '#fff'
      g.beginPath()
      g.arc(x, y, 13 * k, 0, Math.PI * 2)
      g.fill()
      g.strokeStyle = `rgb(${lit ? HOT_CSS[a.kind] : AGENT_RING_IDLE})`
      g.lineWidth = Math.max(1.5, 3.5 * k)
      g.beginPath()
      g.arc(x, y, 25 * k, 0, Math.PI * 2)
      g.stroke()
      g.fillStyle = 'rgba(170,180,230,0.85)'
      g.font = `${Math.round(Math.max(9, 22 * k))}px system-ui, -apple-system, "Segoe UI", sans-serif`
      g.textAlign = 'center'
      g.textBaseline = 'top'
      g.fillText(a.label, x, y + 40 * k)
    }
    g.globalCompositeOperation = 'source-over'
  }

  /**
   * Moves the points between the cloud and the chosen formation. s = 0 cloud,
   * 1 formation; each point follows with its own delay. Returns true while moving.
   */
  private stepShape(now: number, dt: number): boolean {
    if (!this.targets || !this.discs || !this.lines) return false
    let moving = false
    if (this.shape === 'rodizio' && !this.reducedMotion.matches) {
      const r = rotationAt((now - this.shapeT0) / 1000)
      this.formation = r.id
      this.morphS = r.s
      moving = true
    } else {
      // A fixed formation: go back to the cloud first if another one is showing.
      let want = 0
      if (this.shape !== 'nuvem' && this.shape !== 'rodizio') {
        if (this.formation === this.shape || this.morphS === 0) {
          this.formation = this.shape
          want = 1
        }
      }
      if (this.reducedMotion.matches) this.morphS = want
      else if (this.morphS !== want) {
        const step = dt / 3000
        this.morphS =
          want > this.morphS
            ? Math.min(want, this.morphS + step)
            : Math.max(want, this.morphS - step)
        moving = true
      }
    }
    if (this.morphS === this.drawnS && this.formation === this.drawnFormation) return moving
    this.drawnS = this.morphS
    this.drawnFormation = this.formation

    const T = this.targets[this.formation]
    const H = this.home
    const C = this.formed
    const s = this.morphS
    const n = this.delay.length
    for (let i = 0; i < n; i++) {
      const v = s <= 0 ? 0 : easeInOut(Math.min(1, Math.max(0, (s - this.delay[i]!) / 0.65)))
      for (let d = 0; d < 3; d++) C[i * 3 + d] = H[i * 3 + d]! + (T[i * 3 + d]! - H[i * 3 + d]!) * v
    }
    this.formedDirty = true
    // The fibres fade while the shape is up (down to 4%; additive, so many overlapping links still add up).
    this.uFibre.value = 1 - 0.96 * easeInOut(s)
    return moving
  }

  /**
   * cur = formed shape + continuous motion, pushed to the GPU when either one
   * changed. Returns true while the motion is still animating.
   */
  private stepMotion(now: number): boolean {
    if (!this.discs || !this.lines) return false
    const t = now / 1000
    const beat = (now - this.beatAt) / 1000
    const m = this.reducedMotion.matches ? 'parado' : this.motion
    const on =
      m === 'respiracao' ||
      m === 'flutuacao' ||
      m === 'onda' ||
      (m === 'batimento' && beat >= 0 && beat < 2.5)
    if (!on && !this.formedDirty && !this.motionWasOn) return false
    this.motionWasOn = on
    this.formedDirty = false

    const F = this.formed
    const C = this.cur
    const n = F.length / 3
    if (!on) C.set(F)
    else if (m === 'flutuacao') {
      const ph = this.floatPhase
      for (let k = 0; k < n * 3; k++)
        C[k] = F[k]! + 3 * Math.sin(t * (0.7 + (k % 3) * 0.17) + ph[k]!)
    } else if (m === 'onda') {
      C.set(F)
      for (let i = 0; i < n; i++)
        C[i * 3 + 1]! += 9 * Math.sin((F[i * 3]! + F[i * 3 + 2]! * 0.4) / 26 - t * 2.2)
    } else {
      const f = motionScale(m, t, beat)
      for (let k = 0; k < n * 3; k++) C[k] = F[k]! * f
    }
    const pa = this.discs.geometry.attributes.position as THREE.BufferAttribute
    ;(pa.array as Float32Array).set(C)
    pa.needsUpdate = true
    this.discs.geometry.computeBoundingSphere() // the raycaster tests it before the points
    const la = this.lines.geometry.attributes.position as THREE.BufferAttribute
    const L = la.array as Float32Array
    const en = this.edgeNode
    for (let v = 0; v < en.length; v++) {
      const i = en[v]!
      L[v * 3] = C[i * 3]!
      L[v * 3 + 1] = C[i * 3 + 1]!
      L[v * 3 + 2] = C[i * 3 + 2]!
    }
    la.needsUpdate = true
    return on
  }

  /** Colour and size of each neuron for the chosen style (entities keep theirs). */
  private applyStyle() {
    const geo = this.discs?.geometry
    if (!geo) return
    const nodes = this.data.nodes
    const size = geo.attributes.aSize as THREE.BufferAttribute
    const base = geo.attributes.aBase as THREE.BufferAttribute
    // Age as a rank among memories (oldest 0, newest 1), so a burst of old notes doesn't flatten the scale.
    const ageRank = new Float32Array(nodes.length)
    if (this.style === 'idade') {
      const mem = nodes.map((x, i) => i).filter((i) => nodes[i]!.type !== 'entity')
      mem.sort((a, b) => (nodes[a]!.created ?? 0) - (nodes[b]!.created ?? 0))
      mem.forEach((i, k) => (ageRank[i] = mem.length > 1 ? k / (mem.length - 1) : 1))
    }
    nodes.forEach((node, i) => {
      const imp = Math.max(0, Math.min(10, node.importance)) / 10
      if (node.type === 'entity') {
        size.setX(i, 3.4 + Math.sqrt(node.degree) * 0.3)
        base.setXYZ(i, ...BASE_ENTITY)
        return
      }
      const jitter = 0.82 + 0.36 * hash01(node.id)
      let c: V3 = BASE_MEMORY
      let sz = 1.6 + node.importance * 0.16
      if (this.style === 'projeto') {
        const p = this.projectOf[i] ?? -1
        c = p < 0 ? rgb(92, 100, 140) : hsl((p * 0.618034 + 0.58) % 1, 0.62, 0.55)
        sz *= jitter
      } else if (this.style === 'idade') {
        const a = ageRank[i]
        c = ramp([rgb(38, 46, 104), rgb(70, 110, 210), rgb(110, 235, 210)], a!)
        sz = (1.2 + 2.6 * a! * a! + node.importance * 0.05) * jitter
      } else if (this.style === 'importancia') {
        c = ramp([rgb(44, 54, 116), rgb(140, 100, 230), rgb(255, 196, 102)], imp)
        sz = (1.0 + 4.2 * imp ** 1.6) * (0.9 + 0.2 * hash01(node.id))
      }
      size.setX(i, sz)
      base.setXYZ(i, c[0], c[1], c[2])
    })
    size.needsUpdate = true
    base.needsUpdate = true
  }

  private projectNode(i: number) {
    return this.project(this.cur[i * 3]!, this.cur[i * 3 + 1]!, this.cur[i * 3 + 2]!)
  }

  /** Projects a cloud-local point to CSS pixels. Returns a shared object: read it before the next call. */
  private project(x: number, y: number, z: number) {
    const v = this.scratch.set(x, y, z).applyMatrix4(this.cloud.matrixWorld).project(this.camera)
    const o = this.proj
    o.x = (v.x * 0.5 + 0.5) * this.w
    o.y = (-v.y * 0.5 + 0.5) * this.h
    o.visible = v.z < 1 && v.z > -1
    o.z = v.z
    return o
  }

  private placeHover() {
    if (this.hover < 0) return
    const p = this.projectNode(this.hover)
    this.hoverEl.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, 10px)`
  }

  private resize = () => {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    if (w === 0 || h === 0) return
    this.w = w
    this.h = h
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.placeSlots()
    // Re-read the pixel ratio: the window may have moved to another monitor.
    const pr = Math.min(window.devicePixelRatio, 2)
    this.pr = pr
    this.renderer.setPixelRatio(pr)
    this.renderer.setSize(w, h)
    this.overlay.width = Math.round(w * pr)
    this.overlay.height = Math.round(h * pr)
    this.uScale.value = (h * pr * 0.5) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))
    this.uPx.value = (h * pr) / 1080
    this.kick()
  }

  /** devicePixelRatio changes (monitor switch, zoom) don't always resize the container. */
  private watchDpr() {
    this.dprQuery?.removeEventListener('change', this.onDprChange)
    this.dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    this.dprQuery.addEventListener('change', this.onDprChange)
  }

  private onDprChange = () => {
    this.watchDpr()
    this.resize()
  }

  private onControlsChange = () => this.kick()
  private onControlsStart = () => {
    this.tween = null
    this.kick()
  }
  private onLeave = () => this.setHover(-1)

  private pick(e: PointerEvent): number {
    if (!this.discs) return -1
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    )
    this.raycaster.setFromCamera(ndc, this.camera)
    const dist = this.camera.position.distanceTo(this.controls.target)
    this.raycaster.params.Points = { threshold: Math.max(0.6, dist * 0.012) }
    const hits = this.raycaster.intersectObject(this.discs)
    if (hits.length === 0) return -1
    hits.sort((a, b) => (a.distanceToRay ?? 0) - (b.distanceToRay ?? 0))
    return hits[0]!.index ?? -1
  }

  private setHover(i: number) {
    if (i === this.hover) return
    this.hover = i
    this.renderer.domElement.style.cursor = i >= 0 ? 'pointer' : ''
    if (i < 0) {
      this.hoverEl.style.display = 'none'
      return
    }
    const text = this.data.nodes[i]!.label
    this.hoverEl.textContent = text.length > 70 ? `${text.slice(0, 69)}…` : text
    this.hoverEl.style.display = 'block'
    this.kick()
  }

  private onMove = (e: PointerEvent) => {
    if (e.buttons !== 0) return
    this.setHover(this.pick(e))
  }
  private onDown = (e: PointerEvent) => {
    this.downAt = { x: e.clientX, y: e.clientY }
  }
  private onUp = (e: PointerEvent) => {
    if (!this.downAt) return
    const moved = Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y)
    this.downAt = null
    if (moved > 4) return
    const i = this.pick(e)
    this.onSelect(i >= 0 ? this.data.nodes[i]!.id : null)
  }
}
