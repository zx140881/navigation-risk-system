/**
 * Channel3D - 航道三维数字孪生可视化模块
 * 基于 Three.js 实现航道地形、水面、船舶的三维场景渲染
 *
 * 主要功能:
 *   - 全航道三维地形可视化（支持精确模式和简化流光扫描模式）
 *   - 侧面剖视图（Cross-Section）展示航道横截面深度分布
 *   - 船舶3D模型渲染及吃水深度检测
 *   - 边界扫光动画与航段流光扫描效果
 *   - 交互式轨道相机控制（旋转/缩放/平移）
 *   - Raycaster 点击交互（船舶选择、航段点击）
 *
 * 坐标系说明:
 *   x = 经度偏移(米), 1度 ≈ 111000m * cos(lat)
 *   y = 高程(0=水面, 负值=水下), 水下深度会乘以 DEPTH_EXAGGERATION 系数放大
 *   z = 纬度偏移(米), 1度 ≈ 111000m
 *   比例: Three.js 1单位 = 1米
 *
 * 使用流程:
 *   1. new Channel3D(containerId)       — 创建实例
 *   2. channel3d.init(options)            — 初始化 Three.js 场景
 *   3. channel3d.buildFullChannel(data)   — 构建全航道三维视图 或
 *      channel3d.buildSegmentCrossSection() — 构建侧面剖视图
 *   4. channel3d.dispose()                — 销毁释放资源
 *
 * 依赖: three, three/addons/controls/OrbitControls.js
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

// ======================== 常量定义 ========================
// 以下常量控制场景的全局外观、地形精度、深度映射等核心参数

/** 每度纬度对应的米数，用于经纬度到局部坐标的转换基准 */
const METERS_PER_DEG_LAT = 111000;
/** 场景背景色（十六进制）: 深蓝科幻指挥中心风格 */
const BG_COLOR = 0x0a1628;
/** 水面 y 坐标，即水面在 Three.js Y 轴上的位置，所有深度以此为参考面 */
const WATER_Y = 0;
/** 水面透明度 (0~1)，值越小水面越透明，可透视水下地形 */
const WATER_OPACITY = 0.3;
/** 地形网格分辨率（NxN），决定地形 Mesh 的精细程度。值越大越精细，但性能开销也越大 */
const TERRAIN_GRID = 64;
/** 地形超出航段边界的扩展比例（1.3 = 在原边界基础上各方向扩展30%） */
const TERRAIN_PADDING = 1.3;
/** 航道中心线深度范围(米, 负值): 航道最深区域，取 min~-12 到 max~-8 之间的随机值 */
const CHANNEL_CENTER_DEPTH = { min: -12, max: -8 };
/** 航道边缘深度范围(米, 负值): 从中心向两岸过渡的深度区间 */
const CHANNEL_EDGE_DEPTH = { min: -4, max: -2 };
/** 航道外深度(米, 负值): 航道边界之外的浅滩/河床深度 */
const OUTSIDE_DEPTH = -0.5;
/** 货船吃水范围(米): 大型货船的水线以下深度区间 */
const CARGO_DRAFT_RANGE = { min: 3, max: 8 };
/** 小船吃水范围(米): 小型船舶的水线以下深度区间 */
const SMALL_DRAFT_RANGE = { min: 2, max: 5 };
/** 雾效起始距离(米): 小于此距离的场景物体不受雾效影响 */
const FOG_NEAR = 5000;
/** 雾效结束距离(米): 超过此距离的场景物体完全被雾遮挡 */
const FOG_FAR = 80000;
/**
 * 水深夸张系数（倍数）
 * 地形顶点的Y轴偏移 = depth * DEPTH_EXAGGERATION
 * 由于真实水深差异相对于场景尺寸较小，需要放大以使地形起伏在视觉上更明显
 * 例如：-10m 深度 -> Y轴偏移 -200m
 */
const DEPTH_EXAGGERATION = 20;
/** 水面Y坐标（平面基准），与 WATER_Y 含义相同，用于部分方法中的水面定位 */
const WATER_LEVEL_Y = 0;
/** 扫光颜色（十六进制）: 青蓝色，用于边界扫光动画和流光扫描效果 */
const SCAN_LIGHT_COLOR = 0x00d4ff;

// ======================== 工具函数 ========================

/**
 * 经纬度转局部坐标(米)
 * 将地理坐标(WGS84)转换为以参考点为中心的局部笛卡尔坐标(XZ平面)
 * 经度方向距离受纬度影响（越靠近赤道，每度经度对应的米数越大）
 * @param {number} lat - 目标点纬度(度)
 * @param {number} lng - 目标点经度(度)
 * @param {number} centerLat - 参考中心纬度(度)
 * @param {number} centerLng - 参考中心经度(度)
 * @returns {{ x: number, z: number }} 局部坐标(米)，x=东西方向，z=南北方向
 */
function geoToLocal(lat, lng, centerLat, centerLng) {
  const x = (lng - centerLng) * METERS_PER_DEG_LAT * Math.cos(centerLat * Math.PI / 180);
  const z = (lat - centerLat) * METERS_PER_DEG_LAT;
  return { x, z };
}

/**
 * 伪随机数生成器（可种子化，保证同一位置每次生成结果一致）
 * 使用线性同余法(Lehmer RNG)，种子相同时产生相同序列
 * 用于地形深度计算中，确保每次重建场景时地形形状一致
 * @param {number} seed - 随机种子值
 * @returns {Function} 无参函数，每次调用返回 0~1 之间的伪随机数
 */
function seededRandom(seed) {
  let s = seed;
  return function () {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/**
 * 线性插值（Linear Interpolation）
 * 在 a 和 b 之间按比例 t 进行插值，t 被限制在 [0, 1] 范围内
 * 广泛用于深度计算、颜色渐变、动画过渡等场景
 * @param {number} a - 起始值
 * @param {number} b - 目标值
 * @param {number} t - 插值因子(0=a, 1=b)
 * @returns {number} 插值结果
 */
function lerp(a, b, t) {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

/**
 * 计算点到线段的最短距离（二维 XZ 平面）
 * 算法: 先计算点在线段上的投影参数 t，若 t 在 [0,1] 内则距离为垂线距离，
 *       否则取到线段两端点的较近距离
 * 用于判断网格点到航道边界线段的距离，从而推算该点的深度
 * @param {number} px - 目标点 x
 * @param {number} pz - 目标点 z
 * @param {number} ax - 线段起点 x
 * @param {number} az - 线段起点 z
 * @param {number} bx - 线段终点 x
 * @param {number} bz - 线段终点 z
 * @returns {number} 最短距离(米)
 */
function pointToSegmentDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq === 0) return Math.hypot(px - ax, pz - az);
  let t = ((px - ax) * dx + (pz - az) * dz) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

/**
 * 计算船舶吃水深度
 * 优先使用外部导入数据，其次使用船舶自带数据，最后按船长估算
 * @param {object} ship - 船舶数据对象
 * @param {Array|null} externalDraftData - 外部吃水数据 [{name, draft}, ...]
 * @returns {number} 吃水深度(米)
 */
function calculateDraft(ship, externalDraftData) {
  if (!ship) return 4;

  // 1. 优先使用外部导入数据
  if (externalDraftData) {
    const entry = externalDraftData.find(d => d.name === ship.name);
    if (entry && entry.draft !== undefined) return entry.draft;
  }

  // 2. 使用船舶自带数据
  if (ship.draft !== undefined && ship.draft !== null) return ship.draft;

  // 3. 按船长估算
  const len = ship.length || 80;
  if (len > 100) return 4 + Math.random() * 4;   // 大船: 4~8m
  if (len > 60) return 3 + Math.random() * 3;    // 中船: 3~6m
  return 2 + Math.random() * 2;                   // 小船: 2~4m
}

/**
 * 深度值映射为颜色（深色科幻指挥中心风格）
 * 将水下深度(负值)转换为 RGB 颜色，用于地形顶点着色
 * 颜色梯度方案:
 *   极浅/陆地(<1m)   -> 浅沙黄色 (0.65, 0.58, 0.40)
 *   浅水区(1~3m)      -> 黄绿渐变到绿
 *   中等深度(3~6m)    -> 绿渐变到蓝绿
 *   深水区(>6m)       -> 蓝绿渐变到深蓝
 * @param {number} depth - 深度(米, 负值, 如 -10)
 * @returns {{ r: number, g: number, b: number }} RGB 分量，各分量范围 0~1
 */
function depthToColor(depth) {
  const d = Math.abs(depth);
  if (d < 1) {
    // 极浅/陆地: 浅沙黄色
    return { r: 0.65, g: 0.58, b: 0.40 };
  } else if (d < 3) {
    // 浅水: 黄绿到绿
    const t = (d - 1) / 2;
    return {
      r: lerp(0.65, 0.35, t),
      g: lerp(0.58, 0.55, t),
      b: lerp(0.40, 0.30, t)
    };
  } else if (d < 6) {
    // 中等: 绿到蓝绿
    const t = (d - 3) / 3;
    return {
      r: lerp(0.35, 0.10, t),
      g: lerp(0.55, 0.50, t),
      b: lerp(0.30, 0.65, t)
    };
  } else {
    // 深水: 蓝绿到深蓝
    const t = Math.min((d - 6) / 6, 1);
    return {
      r: lerp(0.10, 0.05, t),
      g: lerp(0.50, 0.20, t),
      b: lerp(0.65, 0.85, t)
    };
  }
}

// ======================== 主类 ========================

export class Channel3D {

  /**
   * 构造函数：初始化 Channel3D 实例
   * 仅创建空的对象组和引用，实际的 Three.js 场景在 init() 中创建
   * @param {string} containerId - 用于渲染的 DOM 容器元素 id（如 "channel3d-container"）
   */
  constructor(containerId) {
    /** @type {string} 容器 DOM 元素 id */
    this.containerId = containerId;

    /** @type {HTMLElement|null} 容器 DOM 元素引用，在 init() 中赋值 */
    this.container = null;

    /* ===== Three.js 核心对象 ===== */
    /** @type {THREE.Scene|null} Three.js 场景，在 init() 中创建 */
    this.scene = null;
    /** @type {THREE.PerspectiveCamera|null} 透视相机，用于三维视角渲染 */
    this.camera = null;
    /** @type {THREE.WebGLRenderer|null} WebGL 渲染器，负责绘制场景 */
    this.renderer = null;
    /** @type {OrbitControls|null} 轨道控制器，支持鼠标旋转/缩放/平移 */
    this.controls = null;

    /* ===== 场景对象组（用于分类管理场景中的 Mesh） ===== */
    /** @type {THREE.Group} 地形 Mesh 组，存放航道地形网格 */
    this.terrainGroup = new THREE.Group();
    /** @type {THREE.Group} 水面 Mesh 组，存放半透明水面平面 */
    this.waterGroup = new THREE.Group();
    /** @type {THREE.Group} 船舶模型组，存放船舶 3D 模型或简化标记 */
    this.shipGroup = new THREE.Group();
    /** @type {THREE.Group} 边界线/扫光动画组，存放航道边界可视化和扫光效果 */
    this.boundaryGroup = new THREE.Group();

    /* ===== 当前航段信息 ===== */
    /** @type {object|null} 当前正在查看的航段数据（含 channelData, segId, meta） */
    this.currentSegment = null;
    /** @type {number} 当前航段 ID，-1 表示无航段 */
    this.currentSegId = -1;

    /* ===== 动画控制 ===== */
    /** @type {number|null} requestAnimationFrame 返回的动画帧 ID，用于取消动画 */
    this.animationId = null;
    /** @type {boolean} 实例是否已销毁，防止 dispose 后继续执行动画循环 */
    this._disposed = false;

    /** @type {boolean} 后处理管线是否启用（运动态势模式下设为 false 以降低 GPU 开销） */
    this.composerEnabled = true;

    /* ===== 相机动画 ===== */
    /** @type {object|null} 相机过渡动画状态，包含 fromPos/toPos/fromTarget/toTarget/duration/startTime */
    this._cameraAnim = null;

    /* ===== 深度网格缓存（用于船舶吃水检测） ===== */
    /** @type {Float32Array|null} 一维展平的深度数据数组，索引方式: row * gridWidth + col */
    this._depthGridData = null;
    /** @type {object|null} 深度网格元数据，含 gridMinX/gridMaxX/gridMinZ/gridMaxZ/stepX/stepZ 等 */
    this._depthGridMeta = null;

    /* ===== 外部导入数据 ===== */
    /** @type {Array|null} 外部水深测点数据 [[lat, lng, depth], ...] */
    this._externalDepthData = null;
    /** @type {Array|null} 外部船舶吃水数据 [{name, draft}, ...] */
    this._externalDraftData = null;
    /** @type {Array|null} 上次构建的船舶数据缓存，用于增量更新判断 */
    this._lastShips = null;

    /* ===== 全航道模式 ===== */
    /** @type {boolean} 是否处于全航道视图（区别于单航段视图） */
    this._isFullChannel = false;
    /** @type {object|null} 全航道元数据（合并所有航段的坐标范围） */
    this._fullChannelMeta = null;
    /** @type {Array} 全航道各段地形网格数据缓存，每项含 { depths, meta } */
    this._fullChannelDepthGrids = [];

    /* ===== 边界扫光动画（精确模式下沿航道边界流动的光效） ===== */
    /** @type {THREE.Mesh|null} 扫光主光点球体 Mesh */
    this._scanLight = null;
    /** @type {Array<THREE.Mesh>} 扫光拖尾 Mesh 数组，形成渐隐的尾迹效果 */
    this._scanTrail = [];
    /** @type {Array} 扫光路径点数组（局部坐标），光点沿此路径匀速移动 */
    this._scanPath = [];
    /** @type {number} 扫光进度 0~1，表示光点在路径上的当前位置 */
    this._scanProgress = 0;
    /** @type {number} 扫光速度（每帧递增量），控制光点流动快慢 */
    this._scanSpeed = 0.0003;

    /* ===== 全航道简化模式（流光扫描效果，不渲染精确地形网格） ===== */
    /** @type {boolean} 是否处于简化模式，简化模式只显示边界线和流光，不构建地形 Mesh */
    this._isSimplifiedMode = false;
    /** @type {Array} 各航段流光扫描动画数据，每项含路径点和进度状态 */
    this._segmentScanEffects = [];
    /** @type {Array} 航段边界线 Mesh 数组，用于简化模式下的点击检测 */
    this._segmentBoundaryMeshes = [];
    /** @type {Function|null} 点击航段时的外部回调函数 */
    this._onSegmentClick = null;

    /* ===== 侧面剖视图模式 ===== */
    /** @type {boolean} 是否处于侧面剖视图（Cross-Section）模式 */
    this._isCrossSection = false;
    /** @type {THREE.Group} 剖视图专用对象组，退出时清空 */
    this._crossSectionGroup = new THREE.Group();

    /* ===== 自动巡航模式 ===== */
    /** @type {boolean} 是否处于自动巡航模式 */
    this._isAutoTour = false;
    /** @type {number} 巡航当前航段索引 */
    this._tourIndex = 0;
    /** @type {number|null} 巡航定时器ID */
    this._tourTimer = null;

    /* ===== 船舶运动态势模式 ===== */
    /** @type {boolean} 是否处于船舶运动态势3D视图模式 */
    this._isShipMotion = false;
    /** @type {THREE.Group} 船舶运动态势专用对象组，与其他模式互不干扰 */
    this._shipMotionGroup = new THREE.Group();
    /** @type {Array} 水流箭头粒子数组，用于动画更新 */
    this._currentArrows = [];
    /** @type {Array} 风效箭头粒子数组，用于动画更新 */
    this._windArrows = [];
    /** @type {object|null} 当前运动态势的船舶数据缓存 */
    this._shipMotionData = null;
    /** @type {object|null} 当前运动态势的水文环境数据缓存 */
    this._shipMotionHydrology = null;
    /** @type {object|null} 当前运动态势的六点吃水数据 */
    this._shipMotionDrafts = null;
    /** @type {number} 当前运动态势的横移偏移(米) */
    this._shipMotionLateralOffset = 0;
    /** @type {THREE.Group|null} 当前运动态势的船舶模型组引用(用于实时姿态更新) */
    this._shipMotionShipGroup = null;
    /** @type {Function|null} 水深/横移改变时的外部回调 */
    this._onShipMotionChange = null;
    /** @type {HTMLElement|null} 运动态势DOM控制面板引用 */
    this._shipMotionPanelEl = null;
  }

  /* ===== 初始化 ===== */

  /**
   * 初始化 Three.js 场景、相机、渲染器、控制器、灯光和动画循环
   *
   * 初始化流程:
   *   1. 获取 DOM 容器元素，加载外部水深数据
   *   2. 创建 Scene（背景色 + 雾效）
   *   3. 创建 PerspectiveCamera（透视投影，75度视场角）
   *   4. 创建 WebGLRenderer（抗锯齿 + 阴影 + 高 DPI 适配）
   *   5. 创建 OrbitControls（轨道控制器，限制极角防止翻转到水下）
   *   6. 创建 Raycaster（用于点击交互检测船舶/航段）
   *   7. 设置灯光（环境光 + 方向光）
   *   8. 将各对象组（terrain/water/ship/boundary）添加到场景
   *   9. 绑定 window.resize 事件
   *  10. 启动 requestAnimationFrame 动画循环
   *
   * @param {object} [options] - 可选配置
   * @param {number[][]} [options.depthData] - 外部真实水深数据 [[lat, lng, depth], ...]
   * @param {Array} [options.draftData] - 外部船舶吃水数据 [{name, draft}, ...]
   */
  init(options) {
    // 步骤1: 获取容器DOM元素
    this.container = document.getElementById(this.containerId);
    if (!this.container) {
      console.error(`[Channel3D] 找不到容器元素: ${this.containerId}`);
      return;
    }

    // 保存外部导入的水深数据（如果提供），用于替代程序生成的模拟深度
    if (options && options.depthData) {
      this._externalDepthData = options.depthData;
      console.log(`[Channel3D] 已加载外部水深数据: ${options.depthData.length} 个测深点`);
    }

    // 步骤2: 创建场景，设置深蓝背景色和线性雾效（远处物体渐隐）
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BG_COLOR);
    this.scene.fog = new THREE.Fog(BG_COLOR, FOG_NEAR, FOG_FAR);

    // 步骤3: 创建透视相机，75度视场角，近裁剪面10m，远裁剪面100km
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 600;
    const aspect = w / h;
    this.camera = new THREE.PerspectiveCamera(75, aspect, 10, 100000);
    this.camera.position.set(0, 600, 800); // 初始视角：水面以上斜45度
    this.camera.lookAt(0, 0, 0);

    // 步骤4: 创建WebGL渲染器，启用抗锯齿、PCF软阴影，限制像素比防止性能问题
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.container.appendChild(this.renderer.domElement); // 将canvas追加到DOM

    // 步骤6.5: 初始化后处理管线（Bloom辉光 + FXAA抗锯齿）
    const renderPass = new RenderPass(this.scene, this.camera);
    this._composer = new EffectComposer(this.renderer);
    this._composer.addPass(renderPass);

    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(w, h),
      0.6,    // strength - 辉光强度
      0.4,    // radius - 辉光扩散半径
      0.85   // threshold - 亮度阈值
    );
    this._bloomPass = bloomPass;
    this._composer.addPass(bloomPass);

    // FXAA抗锯齿
    const fxaaPass = new ShaderPass(FXAAShader);
    fxaaPass.uniforms['resolution'].value.set(1 / w, 1 / h);
    this._fxaaPass = fxaaPass;
    this._composer.addPass(fxaaPass);

    // OutputPass 确保正确的色彩空间输出
    this._composer.addPass(new OutputPass());

    // CSS2D 标签渲染器（3D浮动HTML标签）
    this._labelRenderer = new CSS2DRenderer();
    this._labelRenderer.setSize(w, h);
    this._labelRenderer.domElement.style.position = 'absolute';
    this._labelRenderer.domElement.style.top = '0';
    this._labelRenderer.domElement.style.left = '0';
    this._labelRenderer.domElement.style.pointerEvents = 'none';
    this.container.appendChild(this._labelRenderer.domElement);

    // 标签组
    this._labelGroup = new THREE.Group();
    this._labelGroup.name = 'labels';
    this.scene.add(this._labelGroup);

    // 步骤5: 创建轨道控制器（鼠标左键旋转、滚轮缩放、右键平移）
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08; // 阻尼系数，越小越"黏"
    this.controls.maxPolarAngle = Math.PI / 2.1; // 限制最大俯角，防止相机翻到水面以下
    this.controls.minDistance = 100;   // 最近缩放距离
    this.controls.maxDistance = 4000;  // 最远缩放距离
    this.controls.target.set(0, 0, 0); // 默认注视场景原点

    // 步骤6: 创建射线检测器，用于鼠标点击时的场景拾取（船舶选择、航段点击等）
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    this._onClick = this._handleClick.bind(this);
    this.renderer.domElement.addEventListener('click', this._onClick);

    // 简化模式下的航段边界点击事件
    this._onSegmentClickHandler = this._handleSegmentClick.bind(this);
    this.renderer.domElement.addEventListener('click', this._onSegmentClickHandler);

    // 步骤7: 设置灯光系统
    this._setupLights();

    // 步骤8: 将各对象组添加到场景根节点
    this.scene.add(this.terrainGroup);
    this.scene.add(this.waterGroup);
    this.scene.add(this.shipGroup);
    this.scene.add(this.boundaryGroup);

    // 步骤9: 绑定窗口大小变化监听
    this._onResize = this.resize.bind(this);
    window.addEventListener('resize', this._onResize);

    // 步骤10: 启动动画循环（每帧执行一次渲染）
    this._animate();

    console.log('[Channel3D] 初始化完成');
  }

  /**
   * 处理3D场景中的点击事件（船舶选择）
   * @private
   */
  _handleClick(event) {
    if (!this._isCrossSection || !this.camera || !this.renderer) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);

    // 从 _crossSectionGroup 中查找可点击的船舶部件
    const intersects = this.raycaster.intersectObjects(this._crossSectionGroup.children, true);

    for (const intersect of intersects) {
      let obj = intersect.object;
      // 向上查找带有 shipData 的父对象
      while (obj && (!obj.userData || !obj.userData.shipData)) {
        obj = obj.parent;
      }
      if (obj && obj.userData && obj.userData.shipData) {
        this._showShipDetailPanel(obj.userData.shipData);
        return;
      }
    }
  }

  /**
   * 显示船舶详细信息面板
   * @private
   * @param {object} ship - 船舶数据
   */
  _showShipDetailPanel(ship) {
    // 移除旧面板
    const oldPanel = document.getElementById('ship-detail-panel');
    if (oldPanel) oldPanel.remove();

    const panel = document.createElement('div');
    panel.id = 'ship-detail-panel';
    panel.style.cssText = `
      position: absolute; top: 60px; right: 10px; z-index: 1002;
      background: rgba(13,31,60,0.95); border: 1px solid #00d4ff;
      border-radius: 8px; padding: 14px 16px; min-width: 220px;
      color: #e0e8f0; font-size: 12px; line-height: 1.8;
      box-shadow: 0 0 20px rgba(0,212,255,0.3);
    `;

    const riskColor = ship.risk === 'high' ? '#ff4444' : ship.risk === 'medium' ? '#ffaa00' : '#44ff44';
    const riskText = ship.risk === 'high' ? '高风险' : ship.risk === 'medium' ? '中风险' : '低风险';
    const draft = ship.draft || (ship.length > 100 ? 6 : 4);

    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;border-bottom:1px solid #1e4a6e;padding-bottom:6px;">
        <span style="color:#00d4ff;font-size:14px;font-weight:600;">${ship.name || '未知船舶'}</span>
        <button onclick="document.getElementById('ship-detail-panel').remove()" style="background:none;border:none;color:#6a8aa8;cursor:pointer;font-size:16px;">×</button>
      </div>
      <div><span style="color:#6a8aa8;">类型:</span> ${ship.type === 'construction' ? '施工船' : '通航船'} (${ship.subType || ''})</div>
      <div><span style="color:#6a8aa8;">风险等级:</span> <span style="color:${riskColor};font-weight:600;">${riskText}</span></div>
      <div><span style="color:#6a8aa8;">船长:</span> ${ship.length}m | <span style="color:#6a8aa8;">船宽:</span> ${ship.width}m</div>
      <div><span style="color:#6a8aa8;">总吨:</span> ${ship.tonnage || '-'} | <span style="color:#6a8aa8;">吃水:</span> ${draft.toFixed(1)}m</div>
      <div><span style="color:#6a8aa8;">航速:</span> ${ship.speed}节 | <span style="color:#6a8aa8;">航向:</span> ${ship.heading}°</div>
      <div><span style="color:#6a8aa8;">方向:</span> ${ship.direction || '-'} | <span style="color:#6a8aa8;">下一港:</span> ${ship.nextPort || '-'}</div>
      <div><span style="color:#6a8aa8;">MMSI:</span> ${ship.mmsi || '-'} | <span style="color:#6a8aa8;">IMO:</span> ${ship.imo || '-'}</div>
      <div style="margin-top:6px;padding-top:6px;border-top:1px dashed #1e4a6e;">
        <span style="color:#6a8aa8;">AIS:</span> ${ship.ais ? '有' : '无'} | <span style="color:#6a8aa8;">许可:</span> ${ship.permitted ? '已许可' : '未许可'}
      </div>
    `;

    document.body.appendChild(panel);
  }

  /**
   * 设置场景灯光系统
   * 三点光照方案:
   *   - 环境光(AmbientLight): 强度1.8，确保水下区域也可见
   *   - 主方向光(DirectionalLight): 从右上方照射，启用2048x2048阴影贴图
   *   - 补光(DirectionalLight): 从左上方照射，冷蓝色调，填充阴影区域
   * @private
   */
  _setupLights() {
    // 环境光：较高强度(1.8)确保水下凹陷区域也可见
    const ambient = new THREE.AmbientLight(0x667788, 1.8);
    this.scene.add(ambient);

    // 主方向光(冷色调)
    const dirLight = new THREE.DirectionalLight(0xaaccee, 2.0);
    dirLight.position.set(3000, 5000, 2000);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.camera.near = 100;
    dirLight.shadow.camera.far = 50000;
    dirLight.shadow.camera.left = -20000;
    dirLight.shadow.camera.right = 20000;
    dirLight.shadow.camera.top = 20000;
    dirLight.shadow.camera.bottom = -20000;
    this.scene.add(dirLight);

    // 补光(冷蓝色调)
    const fillLight = new THREE.DirectionalLight(0x5577aa, 0.8);
    fillLight.position.set(-2000, 3000, -1000);
    this.scene.add(fillLight);

    // 半球光(深蓝/深棕)
    const hemiLight = new THREE.HemisphereLight(0x556688, 0x332211, 0.6);
    this.scene.add(hemiLight);
  }

  /* ===== 动画循环 ===== */

  /**
   * 动画循环
   * @private
   */
  /**
   * 主动画循环（每帧调用一次）
   * 通过 requestAnimationFrame 递归调用，实现持续的动画更新和场景渲染
   * 帧内执行顺序:
   *   1. 检查实例是否已销毁（_disposed），若已销毁则停止循环
   *   2. 更新相机过渡动画（如有）
   *   3. 更新水面波浪动画（顶点Y轴正弦波动）
   *   4. 更新边界扫光/流光扫描动画（根据模式选择）
   *   5. 更新轨道控制器（处理阻尼惯性）
   *   6. 执行一次场景渲染
   * @private
   */
  _animate() {
    if (this._disposed) return; // 实例已销毁，终止动画循环
    this.animationId = requestAnimationFrame(() => this._animate());

    // 1. 相机过渡动画（位置和注视点的平滑插值）
    this._updateCameraAnimation();

    // 2. 水面微波动画（修改水面顶点产生波浪效果）
    this._animateWater();

    // 3. 边界扫光动画（根据当前模式选择不同的扫光效果）
    if (this._isSimplifiedMode) {
      this._animateSegmentScans();  // 简化模式：各航段独立的流光扫描
    } else {
      this._animateBoundaryScan();  // 精确模式：统一的边界扫光
    }

    // 4. 更新轨道控制器（使阻尼惯性生效）
    if (this.controls) {
      this.controls.update();
    }


    // 5. 渲染一帧画面（使用后处理管线或直接渲染）
    if (this.renderer && this.scene && this.camera) {
      if (this._isShipMotion && !this.composerEnabled) {
        // 运动态势模式：跳过后处理，直接渲染
        this.renderer.render(this.scene, this.camera);
      } else if (this._composer) {
        this._composer.render();
      } else {
        this.renderer.render(this.scene, this.camera);
      }
    }

    // 6. 渲染CSS2D标签
    if (this._labelRenderer) {
      this._labelRenderer.render(this.scene, this.camera);
    }
  }

  /**
   * 水面微波动画
   * 遍历水面组中所有 Mesh 的顶点，使用正弦/余弦函数产生Y轴方向的微小波浪
   * 波浪频率和振幅固定，形成自然的水面起伏效果
   * @private
   */
  _animateWater() {
    const time = performance.now() * 0.001;
    this.waterGroup.children.forEach(child => {
      if (child.geometry && child.geometry.attributes.position) {
        const pos = child.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i);
          const z = pos.getZ(i);
          const wave = Math.sin(x * 0.02 + time) * 0.3 +
                       Math.cos(z * 0.015 + time * 0.8) * 0.2;
          pos.setY(i, WATER_Y + wave);
        }
        pos.needsUpdate = true;
      }
    });
  }

  /**
   * 缓动函数集合：支持多种缓动曲线
   * @private
   */
  _easeOutExpo(t) { return t === 1 ? 1 : 1 - Math.pow(2, -10 * t); }
  _easeInOutCubic(t) { return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2; }

  /**
   * 更新相机过渡动画
   * 使用可配置的缓动函数在 fromPos->toPos 和 fromTarget->toTarget 之间平滑插值
   * 动画完成后（elapsed >= duration）自动清除 _cameraAnim 状态
   * @private
   */
  _updateCameraAnimation() {
    if (!this._cameraAnim) return;

    const anim = this._cameraAnim;
    const elapsed = performance.now() - anim.startTime;
    const duration = anim.duration;
    let t = Math.min(elapsed / duration, 1);

    // 使用自定义缓动函数或默认 cubic
    const easeFn = anim.easeFn || this._easeInOutCubic;
    t = easeFn(t);

    this.camera.position.lerpVectors(anim.fromPos, anim.toPos, t);
    if (anim.toTarget) {
      this.controls.target.lerpVectors(anim.fromTarget, anim.toTarget, t);
    }

    if (elapsed >= duration) {
      this._cameraAnim = null;
    }
  }

  /* ===== 深度网格生成 ===== */

  /**
   * 生成深度网格数据
   * 根据航道边界点计算区域内每个网格点的深度值
   *
   * @param {Array} northBoundary - 北边界坐标数组 [[lat, lng], ...]
   * @param {Array} southBoundary - 南边界坐标数组 [[lat, lng], ...]
   * @param {number} gridWidth - 网格宽度(列数)
   * @param {number} gridHeight - 网格高度(行数)
   * @returns {{ depths: number[][], meta: object }} 深度二维数组和元数据
   *
   * TODO: 替换为真实水深测量数据导入
   * 预期格式: { lat, lng, depth } 数组或 GeoTIFF
   */
  generateDepthGrid(northBoundary, southBoundary, gridWidth, gridHeight) {
    if (!northBoundary || !southBoundary || northBoundary.length < 2 || southBoundary.length < 2) {
      console.warn('[Channel3D] 边界数据不足, 无法生成深度网格');
      return { depths: [], meta: null };
    }

    // 如果有外部导入的水深数据，使用IDW插值
    if (this._externalDepthData && this._externalDepthData.length > 0) {
      return this._interpolateDepthFromData(northBoundary, southBoundary, gridWidth, gridHeight);
    }

    // 计算所有边界点的经纬度范围
    const allLats = [...northBoundary, ...southBoundary].map(p => p[0]);
    const allLngs = [...northBoundary, ...southBoundary].map(p => p[1]);
    const minLat = Math.min(...allLats);
    const maxLat = Math.max(...allLats);
    const minLng = Math.min(...allLngs);
    const maxLng = Math.max(...allLngs);

    // 扩展范围
    const latRange = maxLat - minLat;
    const lngRange = maxLng - minLng;
    const padLat = latRange * (TERRAIN_PADDING - 1) / 2;
    const padLng = lngRange * (TERRAIN_PADDING - 1) / 2;

    const extMinLat = minLat - padLat;
    const extMaxLat = maxLat + padLat;
    const extMinLng = minLng - padLng;
    const extMaxLng = maxLng + padLng;

    // 中心点
    const centerLat = (extMinLat + extMaxLat) / 2;
    const centerLng = (extMinLng + extMaxLng) / 2;

    // 将边界转为局部坐标
    const northLocal = northBoundary.map(p => geoToLocal(p[0], p[1], centerLat, centerLng));
    const southLocal = southBoundary.map(p => geoToLocal(p[0], p[1], centerLat, centerLng));

    // 计算局部坐标范围
    const allX = [...northLocal, ...southLocal].map(p => p.x);
    const allZ = [...northLocal, ...southLocal].map(p => p.z);
    const localMinX = Math.min(...allX);
    const localMaxX = Math.max(...allX);
    const localMinZ = Math.min(...allZ);
    const localMaxZ = Math.max(...allZ);

    // 扩展局部范围
    const localRangeX = localMaxX - localMinX;
    const localRangeZ = localMaxZ - localMinZ;
    const padLocalX = localRangeX * (TERRAIN_PADDING - 1) / 2;
    const padLocalZ = localRangeZ * (TERRAIN_PADDING - 1) / 2;

    const gridMinX = localMinX - padLocalX;
    const gridMaxX = localMaxX + padLocalX;
    const gridMinZ = localMinZ - padLocalZ;
    const gridMaxZ = localMaxZ + padLocalZ;

    const stepX = (gridMaxX - gridMinX) / (gridWidth - 1);
    const stepZ = (gridMaxZ - gridMinZ) / (gridHeight - 1);

    // 估算航道宽度(用于判断点是否在航道内)
    let channelWidth = 0;
    const sampleCount = Math.min(northBoundary.length, southBoundary.length);
    for (let i = 0; i < sampleCount; i++) {
      const n = northLocal[i];
      const s = southLocal[i];
      channelWidth += Math.hypot(n.x - s.x, n.z - s.z);
    }
    channelWidth /= sampleCount;
    const halfWidth = channelWidth / 2;

    // 用种子随机保证可重复
    const rng = seededRandom(42);

    // 生成深度
    const depths = [];
    for (let row = 0; row < gridHeight; row++) {
      const rowDepths = [];
      for (let col = 0; col < gridWidth; col++) {
        const px = gridMinX + col * stepX;
        const pz = gridMinZ + row * stepZ;

        // 计算到航道中心线的最近距离
        let minDistToCenter = Infinity;
        let minDistToNorth = Infinity;
        let minDistToSouth = Infinity;

        for (let i = 0; i < northLocal.length - 1; i++) {
          const d = pointToSegmentDist(px, pz,
            northLocal[i].x, northLocal[i].z,
            northLocal[i + 1].x, northLocal[i + 1].z);
          if (d < minDistToNorth) minDistToNorth = d;
        }
        for (let i = 0; i < southLocal.length - 1; i++) {
          const d = pointToSegmentDist(px, pz,
            southLocal[i].x, southLocal[i].z,
            southLocal[i + 1].x, southLocal[i + 1].z);
          if (d < minDistToSouth) minDistToSouth = d;
        }

        // 点到航道边界的最小距离
        const minDistToBoundary = Math.min(minDistToNorth, minDistToSouth);

        // 计算到中心线的距离(用北南边界中点近似)
        for (let i = 0; i < sampleCount; i++) {
          const cx = (northLocal[i].x + southLocal[i].x) / 2;
          const cz = (northLocal[i].z + southLocal[i].z) / 2;
          const nextI = Math.min(i + 1, sampleCount - 1);
          const cx2 = (northLocal[nextI].x + southLocal[nextI].x) / 2;
          const cz2 = (northLocal[nextI].z + southLocal[nextI].z) / 2;
          const d = pointToSegmentDist(px, pz, cx, cz, cx2, cz2);
          if (d < minDistToCenter) minDistToCenter = d;
        }

        let depth;
        // 使用到中心线的距离判断深度区域
        if (minDistToCenter < halfWidth * 0.5) {
          // 航道中心区域: 最深
          const noise = rng() * (CHANNEL_CENTER_DEPTH.max - CHANNEL_CENTER_DEPTH.min);
          depth = CHANNEL_CENTER_DEPTH.min + noise;
        } else if (minDistToCenter < halfWidth * 0.9) {
          // 航道内但靠近边缘: 中等深度
          const t = (minDistToCenter - halfWidth * 0.5) / (halfWidth * 0.4);
          const centerDepth = lerp(CHANNEL_CENTER_DEPTH.min, CHANNEL_CENTER_DEPTH.max, rng());
          const edgeDepth = lerp(CHANNEL_EDGE_DEPTH.min, CHANNEL_EDGE_DEPTH.max, rng());
          depth = lerp(centerDepth, edgeDepth, t);
        } else if (minDistToBoundary < halfWidth * 1.5) {
          // 航道边缘: 浅
          const t = (minDistToBoundary - halfWidth) / (halfWidth * 0.5);
          const edgeDepth = lerp(CHANNEL_EDGE_DEPTH.min, CHANNEL_EDGE_DEPTH.max, rng());
          depth = lerp(edgeDepth, OUTSIDE_DEPTH, Math.max(0, Math.min(t, 1)));
        } else {
          // 航道外: 接近水面
          depth = OUTSIDE_DEPTH;
        }

        rowDepths.push(depth);
      }
      depths.push(rowDepths);
    }

    const meta = {
      gridMinX, gridMaxX, gridMinZ, gridMaxZ,
      stepX, stepZ,
      gridWidth, gridHeight,
      centerLat, centerLng,
      halfWidth
    };

    return { depths, meta };
  }

  /**
   * 使用外部水深测点数据通过IDW(反距离加权)插值生成深度网格
   * @private
   */
  _interpolateDepthFromData(northBoundary, southBoundary, gridWidth, gridHeight) {
    const allPts = [...northBoundary, ...southBoundary];
    const allLats = allPts.map(p => p[0]);
    const allLngs = allPts.map(p => p[1]);
    const minLat = Math.min(...allLats);
    const maxLat = Math.max(...allLats);
    const minLng = Math.min(...allLngs);
    const maxLng = Math.max(...allLngs);

    const latRange = maxLat - minLat;
    const lngRange = maxLng - minLng;
    const padLat = latRange * (TERRAIN_PADDING - 1) / 2;
    const padLng = lngRange * (TERRAIN_PADDING - 1) / 2;

    const extMinLat = minLat - padLat;
    const extMaxLat = maxLat + padLat;
    const extMinLng = minLng - padLng;
    const extMaxLng = maxLng + padLng;

    const centerLat = (extMinLat + extMaxLat) / 2;
    const centerLng = (extMinLng + extMaxLng) / 2;

    const northLocal = northBoundary.map(p => geoToLocal(p[0], p[1], centerLat, centerLng));
    const southLocal = southBoundary.map(p => geoToLocal(p[0], p[1], centerLat, centerLng));

    const allX = [...northLocal, ...southLocal].map(p => p.x);
    const allZ = [...northLocal, ...southLocal].map(p => p.z);
    const localMinX = Math.min(...allX);
    const localMaxX = Math.max(...allX);
    const localMinZ = Math.min(...allZ);
    const localMaxZ = Math.max(...allZ);

    const localRangeX = localMaxX - localMinX;
    const localRangeZ = localMaxZ - localMinZ;
    const padLocalX = localRangeX * (TERRAIN_PADDING - 1) / 2;
    const padLocalZ = localRangeZ * (TERRAIN_PADDING - 1) / 2;

    const gridMinX = localMinX - padLocalX;
    const gridMaxX = localMaxX + padLocalX;
    const gridMinZ = localMinZ - padLocalZ;
    const gridMaxZ = localMaxZ + padLocalZ;

    const stepX = (gridMaxX - gridMinX) / (gridWidth - 1);
    const stepZ = (gridMaxZ - gridMinZ) / (gridHeight - 1);

    // 将外部测点转为局部坐标
    const localDepthPts = this._externalDepthData.map(pt => ({
      x: (pt.lng - centerLng) * METERS_PER_DEG_LAT * Math.cos(centerLat * Math.PI / 180),
      z: (pt.lat - centerLat) * METERS_PER_DEG_LAT,
      depth: pt.depth
    }));

    // IDW插值参数
    const power = 2; // 反距离权重指数
    const maxSearchDist = 2000; // 最大搜索半径(米)

    const depths = [];
    for (let row = 0; row < gridHeight; row++) {
      const rowDepths = [];
      for (let col = 0; col < gridWidth; col++) {
        const px = gridMinX + col * stepX;
        const pz = gridMinZ + row * stepZ;

        let weightSum = 0;
        let depthSum = 0;
        let found = false;

        for (const pt of localDepthPts) {
          const dist = Math.hypot(px - pt.x, pz - pt.z);
          if (dist < maxSearchDist) {
            const w = 1 / Math.pow(dist + 0.1, power); // +0.1 避免除零
            weightSum += w;
            depthSum += w * pt.depth;
            found = true;
          }
        }

        if (found && weightSum > 0) {
          rowDepths.push(depthSum / weightSum);
        } else {
          // 超出测点范围的区域，使用默认浅水
          rowDepths.push(OUTSIDE_DEPTH);
        }
      }
      depths.push(rowDepths);
    }

    const meta = {
      gridMinX, gridMaxX, gridMinZ, gridMaxZ,
      stepX, stepZ,
      gridWidth, gridHeight,
      centerLat, centerLng
    };

    console.log(`[Channel3D] 使用外部水深数据IDW插值完成, ${localDepthPts.length} 个测点`);
    return { depths, meta };
  }

  /* ===== 构建全航道视图 ===== */

  /**
   * 构建整个航道(南槽下段+上段+南支)的3D场景
   *
   * 构建流程:
   *   1. 清除所有旧场景对象（地形/水面/边界/船舶）
   *   2. 清除旧的扫光效果，退出剖视图模式
   *   3. 计算所有航段的全局边界范围，确定统一的参考中心点
   *   4. 遍历三个航段（下段/上段/南支），分别为每段构建地形网格或计算范围
   *   5. 为每段创建发光边界线（北边界绿色，南边界橙色，南支紫色）
   *   6. 简化模式下为每段创建独立的流光扫描效果
   *   7. 合并所有航段深度数据到统一缓存
   *   8. 创建覆盖全航道范围的统一水面
   *   9. 构建警戒区和航段分界线
   *  10. 根据模式构建船舶模型或简化标记
   *  11. 聚焦相机到全航道中心
   *  12. 初始化边界扫光/流光扫描动画
   *
   * @param {object} channelDataMap - 各段航道数据
   *   { lower: {north_boundary, south_boundary}, upper: {north_boundary, south_boundary}, branch: {north_boundary, south_boundary} }
   * @param {Array} allShips - 所有船舶数据(含lat, lng, draft)
   * @param {object} [options] - 可选配置
   * @param {boolean} [options.simplified=false] - 是否使用简化模式（流光扫描效果，不渲染精确地形）
   * @param {Function} [options.onSegmentClick] - 点击航段回调函数(segId)
   */
  buildFullChannel(channelDataMap, allShips, options = {}) {
    // 步骤1: 清除所有旧场景对象组
    this._clearGroup(this.terrainGroup);
    this._clearGroup(this.waterGroup);
    this._clearGroup(this.boundaryGroup);
    this._clearGroup(this.shipGroup);

    // 步骤2: 清除旧的扫光效果，释放GPU资源
    this._scanPath = [];
    if (this._scanLight) {
      this.boundaryGroup.remove(this._scanLight);
      this._scanLight.geometry.dispose();
      this._scanLight.material.dispose();
      this._scanLight = null;
    }
    this._scanTrail.forEach(m => {
      this.boundaryGroup.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    });
    this._scanTrail = [];

    // 如果当前处于剖视图模式，先退出
    if (this._isCrossSection) {
      this.exitCrossSection();
    }
    // 如果当前处于船舶运动态势模式，先退出
    if (this._isShipMotion) {
      this.exitShipMotion();
    }

    if (!channelDataMap) return;

    // 步骤3: 汇总所有航段的边界点，计算全局经纬度范围
    const allBoundaries = [
      ...(channelDataMap.lower?.north_boundary || []),
      ...(channelDataMap.lower?.south_boundary || []),
      ...(channelDataMap.upper?.north_boundary || []),
      ...(channelDataMap.upper?.south_boundary || []),
      ...(channelDataMap.branch?.north_boundary || []),
      ...(channelDataMap.branch?.south_boundary || [])
    ];

    if (allBoundaries.length < 4) {
      console.warn('[Channel3D] 全航道边界数据不足');
      return;
    }

    // 计算全局边界框
    const allLats = allBoundaries.map(p => p[0]);
    const allLngs = allBoundaries.map(p => p[1]);
    const minLat = Math.min(...allLats);
    const maxLat = Math.max(...allLats);
    const minLng = Math.min(...allLngs);
    const maxLng = Math.max(...allLngs);

    // 全局参考中心点（所有航段的地理中心）
    const centerLat = (minLat + maxLat) / 2;
    const centerLng = (minLng + maxLng) / 2;
    this._refLat = centerLat;
    this._refLng = centerLng;

    // 步骤4: 定义三个航段配置，遍历构建
    const sections = [
      { data: channelDataMap.lower, label: '南槽下段', segIds: [1, 2, 3, 4, 5, 6] },
      { data: channelDataMap.upper, label: '南槽上段', segIds: [7, 8, 9, 10, 11] },
      { data: channelDataMap.branch, label: '南支航道', segIds: [12, 13, 14] }
    ];

    // 用于记录所有航段的合并坐标范围
    let globalMinX = Infinity, globalMaxX = -Infinity;
    let globalMinZ = Infinity, globalMaxZ = -Infinity;

    // 清空全航道深度网格缓存和航段效果
    this._fullChannelDepthGrids = [];
    this._segmentScanEffects = [];
    this._segmentBoundaryMeshes = [];
    this._isSimplifiedMode = options.simplified === true;
    this._onSegmentClick = options.onSegmentClick || null;

    sections.forEach(sec => {
      if (!sec || !sec.data) return;
      const { north_boundary, south_boundary } = sec.data;
      if (!north_boundary || !south_boundary) return;

      // 精确模式：为该航段构建64x64的地形网格Mesh
      if (!this._isSimplifiedMode) {
        // 构建该段地形（精确模式）
        const result = this._buildSectionTerrain(north_boundary, south_boundary, centerLat, centerLng, TERRAIN_GRID);
        if (result) {
          this.terrainGroup.add(result.mesh);
          globalMinX = Math.min(globalMinX, result.meta.gridMinX);
          globalMaxX = Math.max(globalMaxX, result.meta.gridMaxX);
          globalMinZ = Math.min(globalMinZ, result.meta.gridMinZ);
          globalMaxZ = Math.max(globalMaxZ, result.meta.gridMaxZ);

          // 保存该段深度数据到缓存数组（BUG-1修复）
          this._fullChannelDepthGrids.push({
            depths: result.depths,
            meta: result.meta
          });
        }
      } else {
        // 简化模式：只计算范围用于后续流光效果
        const allLocal = [...north_boundary, ...south_boundary].map(p => geoToLocal(p[0], p[1], centerLat, centerLng));
        const secMinX = Math.min(...allLocal.map(p => p.x));
        const secMaxX = Math.max(...allLocal.map(p => p.x));
        const secMinZ = Math.min(...allLocal.map(p => p.z));
        const secMaxZ = Math.max(...allLocal.map(p => p.z));
        globalMinX = Math.min(globalMinX, secMinX);
        globalMaxX = Math.max(globalMaxX, secMaxX);
        globalMinZ = Math.min(globalMinZ, secMinZ);
        globalMaxZ = Math.max(globalMaxZ, secMaxZ);
      }

      // 步骤5: 创建该航段的边界线（发光材质，悬浮在水面上方5m）
      // 南槽航道：北边界绿色(0x00ff88)，南边界橙色(0xff8800)
      // 南支航道：紫色(0xaa88ff)
      // 边界线高度：水面上方5m
      const bndLineY = WATER_LEVEL_Y + 5;
      [
        { pts: north_boundary, color: northColor },
        { pts: south_boundary, color: southColor }
      ].forEach(({ pts, color }) => {
        if (!pts || pts.length < 2) return;
        const verts = [];
        pts.forEach(p => {
          const lp = geoToLocal(p[0], p[1], centerLat, centerLng);
          verts.push(lp.x, bndLineY, lp.z);
        });
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        // 使用发光材质
        const mat = new THREE.LineBasicMaterial({
          color, linewidth: 2, transparent: true, opacity: 0.9
        });
        this.boundaryGroup.add(new THREE.Line(geo, mat));

        // 收集扫光路径点
        pts.forEach(p => {
          const lp = geoToLocal(p[0], p[1], centerLat, centerLng);
          this._scanPath.push({ x: lp.x, y: bndLineY, z: lp.z });
        });
      });

      // 步骤6: 简化模式下为每个航段创建独立的流光扫描效果
      if (this._isSimplifiedMode && sec.segIds) {
        sec.segIds.forEach(segId => {
          this._buildSegmentScanEffect(segId, north_boundary, south_boundary, centerLat, centerLng, sec.label);
        });
      }
    });

    // 步骤7: 精确模式下合并所有航段的深度数据到统一的 _depthGridData
    if (!this._isSimplifiedMode) {
      this._mergeFullChannelDepthGrids(globalMinX, globalMaxX, globalMinZ, globalMaxZ);
    }

    // 保存全局元数据（合并后的坐标范围，用于相机聚焦和坐标转换）
    const mergedGridSize = 128;
    this._depthGridMeta = {
      gridMinX: globalMinX, gridMaxX: globalMaxX,
      gridMinZ: globalMinZ, gridMaxZ: globalMaxZ,
      centerLat, centerLng,
      halfWidth: 500, // 近似值
      gridWidth: mergedGridSize, gridHeight: mergedGridSize,
      stepX: (globalMaxX - globalMinX) / (mergedGridSize - 1),
      stepZ: (globalMaxZ - globalMinZ) / (mergedGridSize - 1)
    };

    // 步骤8: 创建覆盖全航道范围的统一半透明水面
    this.buildWaterSurface({ minX: globalMinX, maxX: globalMaxX, minZ: globalMinZ, maxZ: globalMaxZ });

    // 步骤9: 构建警戒区水域（九段沙、圆圆沙）
    if (channelDataMap.jiuduansha_warning) {
      this._buildWarningZone(channelDataMap.jiuduansha_warning, centerLat, centerLng, 0xff4444, '九段沙警戒区');
    }
    if (channelDataMap.yuanyuansha_warning) {
      this._buildWarningZone(channelDataMap.yuanyuansha_warning, centerLat, centerLng, 0xff8800, '圆圆沙警戒区');
    }

    // 航段分界线
    this._buildSegmentDividers(channelDataMap, centerLat, centerLng);

    // 步骤10: 根据模式构建船舶模型（精确模式）或简化标记（简化模式）
    if (!this._isSimplifiedMode && allShips && allShips.length > 0) {
      this._lastShips = allShips;
      this.currentSegId = 0;
      this.currentSegment = { channelData: channelDataMap, segId: 0, meta: this._depthGridMeta };
      this._isFullChannel = true;
      this._buildShipModels(allShips);
    } else if (this._isSimplifiedMode) {
      // 简化模式：保存船舶数据，并渲染简化船舶点标记
      this._lastShips = allShips;
      this.currentSegId = 0;
      this.currentSegment = { channelData: channelDataMap, segId: 0, meta: this._depthGridMeta };
      this._isFullChannel = true;
      // 渲染简化船舶标记（小球体+竖线）
      if (allShips && allShips.length > 0) {
        this._buildSimplifiedShipMarkers(allShips, channelDataMap.centerLat, channelDataMap.centerLng);
      }
    }

    // 步骤10.5: 为航段和船舶创建CSS2D浮动标签
    const SEGMENTS_DATA = window.SEGMENTS || [];
    if (SEGMENTS_DATA.length > 0 && this._labelGroup) {
      SEGMENTS_DATA.forEach(seg => {
        if (seg && seg.center && this._refLat) {
          const local = geoToLocal(seg.center[0], seg.center[1], this._refLat, this._refLng);
          const label = this._createSegmentCSS2DLabel(
            seg.name || `航段${seg.id}`,
            local.x, 10, local.z,
            seg.risk || 0
          );
          this._labelGroup.add(label);
        }
      });
    }

    // 为简化模式下的船舶创建CSS2D标签
    if (this._isSimplifiedMode && allShips && allShips.length > 0 && this._labelGroup) {
      const cLat = channelDataMap.centerLat || this._refLat;
      const cLng = channelDataMap.centerLng || this._refLng;
      allShips.forEach(ship => {
        const shipLat = ship._lat !== undefined ? ship._lat : ship.lat;
        const shipLng = ship._lng !== undefined ? ship._lng : ship.lng;
        if (shipLat !== undefined && shipLng !== undefined) {
          const local = geoToLocal(shipLat, shipLng, cLat, cLng);
          const label = this._createShipCSS2DLabel(
            ship.name || '船舶', ship.type || '',
            local.x, WATER_LEVEL_Y + 60, local.z
          );
          this._labelGroup.add(label);
        }
      });
    }

    // 步骤11: 聚焦相机到全航道中心，调整视距以完整显示全航道
    this._focusFullChannel();

    // 步骤12: 初始化边界扫光动画（精确模式用统一扫光，简化模式用各段独立流光）
    if (this._isSimplifiedMode) {
      this._initSegmentScans();
    } else {
      this._initBoundaryScan();
    }

    const rangeX = globalMaxX - globalMinX;
    const rangeZ = globalMaxZ - globalMinZ;
    console.log(`[Channel3D] 全航道构建完成, 范围: ${rangeX.toFixed(0)}x${rangeZ.toFixed(0)}m, 船舶: ${allShips?.length || 0}`);
  }

  /**
   * 合并全航道各段深度网格到统一的 Float32Array
   * 使用最近邻采样，从各段局部网格合并到全局网格
   * @private
   */
  _mergeFullChannelDepthGrids(globalMinX, globalMaxX, globalMinZ, globalMaxZ) {
    const mergedSize = 128;
    const totalCells = mergedSize * mergedSize;
    const merged = new Float32Array(totalCells);

    // 初始化默认值
    for (let i = 0; i < totalCells; i++) {
      merged[i] = OUTSIDE_DEPTH;
    }

    const stepX = (globalMaxX - globalMinX) / (mergedSize - 1);
    const stepZ = (globalMaxZ - globalMinZ) / (mergedSize - 1);

    // 对每个全局网格点，查找包含它的航段深度数据
    for (let row = 0; row < mergedSize; row++) {
      for (let col = 0; col < mergedSize; col++) {
        const px = globalMinX + col * stepX;
        const pz = globalMinZ + row * stepZ;

        // 查找包含该点的航段
        for (const seg of this._fullChannelDepthGrids) {
          const m = seg.meta;
          if (px >= m.gridMinX && px <= m.gridMaxX && pz >= m.gridMinZ && pz <= m.gridMaxZ) {
            // 在该航段网格中查找最近点
            const localCol = Math.round((px - m.gridMinX) / m.stepX);
            const localRow = Math.round((pz - m.gridMinZ) / m.stepZ);
            const localC = Math.max(0, Math.min(localCol, m.gridWidth - 1));
            const localR = Math.max(0, Math.min(localRow, m.gridHeight - 1));
            merged[row * mergedSize + col] = seg.depths[localR][localC];
            break; // 找到第一个包含的航段即可
          }
        }
      }
    }

    this._depthGridData = merged;
    console.log(`[Channel3D] 全航道深度网格合并完成: ${mergedSize}x${mergedSize}`);
  }

  /**
   * 构建单段航道的三维地形网格
   *
   * 算法流程:
   *   1. 将边界点从经纬度转换为局部坐标，计算该段的最小包围矩形
   *   2. 在包围矩形基础上扩展30%的padding，生成 gridSize x gridSize 的规则网格
   *   3. 对每个网格点计算到北边界和南边界的最短距离
   *   4. 根据到边界的距离关系推算深度:
   *      - 中心区域(normalizedDist < 0.4): 深水区(-12~-8m)
   *      - 中间区域(0.4~0.8): 从深水向浅水过渡
   *      - 边缘区域(到边界 < 1.8倍半宽): 浅水过渡(-4~-0.5m)
   *      - 航道外: 极浅(-0.5m)
   *   5. 将深度值乘以 DEPTH_EXAGGERATION 后设置到 PlaneGeometry 顶点Y轴
   *   6. 根据深度值映射顶点颜色（depthToColor），创建顶点着色地形
   *
   * @param {Array} northBoundary - 北边界坐标 [[lat, lng], ...]
   * @param {Array} southBoundary - 南边界坐标 [[lat, lng], ...]
   * @param {number} centerLat - 参考中心纬度
   * @param {number} centerLng - 参考中心经度
   * @param {number} gridSize - 网格分辨率(如64)
   * @returns {{ mesh: THREE.Mesh, meta: object, depths: number[][] }|null} 地形Mesh、元数据和深度数组
   * @private
   */
  _buildSectionTerrain(northBoundary, southBoundary, centerLat, centerLng, gridSize) {
    if (!northBoundary || northBoundary.length < 2 || !southBoundary || southBoundary.length < 2) return null;

    // 步骤1: 将所有边界点转为局部坐标，计算最小包围矩形
    const allPts = [...northBoundary, ...southBoundary];
    const allLocal = allPts.map(p => geoToLocal(p[0], p[1], centerLat, centerLng));
    const localMinX = Math.min(...allLocal.map(p => p.x));
    const localMaxX = Math.max(...allLocal.map(p => p.x));
    const localMinZ = Math.min(...allLocal.map(p => p.z));
    const localMaxZ = Math.max(...allLocal.map(p => p.z));

    // 步骤2: 在包围矩形基础上扩展30%的padding，确保地形覆盖航段边缘
    const padFactor = 0.3;
    const rangeX = localMaxX - localMinX;
    const rangeZ = localMaxZ - localMinZ;
    const gridMinX = localMinX - rangeX * padFactor;
    const gridMaxX = localMaxX + rangeX * padFactor;
    const gridMinZ = localMinZ - rangeZ * padFactor;
    const gridMaxZ = localMaxZ + rangeZ * padFactor;

    // 计算网格步长
    const stepX = (gridMaxX - gridMinX) / (gridSize - 1);
    const stepZ = (gridMaxZ - gridMinZ) / (gridSize - 1);

    // 将边界点转为局部坐标（用于距离计算）
    const northLocal = northBoundary.map(p => geoToLocal(p[0], p[1], centerLat, centerLng));
    const southLocal = southBoundary.map(p => geoToLocal(p[0], p[1], centerLat, centerLng));

    // 估算航道宽度（取南北边界对应点距离的平均值）
    let channelWidth = 0;
    const sampleCount = Math.min(northLocal.length, southLocal.length);
    for (let i = 0; i < sampleCount; i++) {
      channelWidth += Math.hypot(northLocal[i].x - southLocal[i].x, northLocal[i].z - southLocal[i].z);
    }
    channelWidth /= sampleCount;
    const halfWidth = channelWidth / 2;

    // 使用确定性伪随机数生成器（相同位置每次结果一致）
    const rng = seededRandom(42 + Math.round(centerLat * 1000) + Math.round(centerLng * 1000));

    // 步骤3~4: 生成深度网格（逐点计算到边界的距离，推算深度值）
    const depths = [];
    for (let row = 0; row < gridSize; row++) {
      const rowDepths = [];
      for (let col = 0; col < gridSize; col++) {
        const px = gridMinX + col * stepX;
        const pz = gridMinZ + row * stepZ;

        let minDistToNorth = Infinity;
        let minDistToSouth = Infinity;

        for (let i = 0; i < northLocal.length - 1; i++) {
          const d = pointToSegmentDist(px, pz, northLocal[i].x, northLocal[i].z, northLocal[i+1].x, northLocal[i+1].z);
          if (d < minDistToNorth) minDistToNorth = d;
        }
        for (let i = 0; i < southLocal.length - 1; i++) {
          const d = pointToSegmentDist(px, pz, southLocal[i].x, southLocal[i].z, southLocal[i+1].x, southLocal[i+1].z);
          if (d < minDistToSouth) minDistToSouth = d;
        }

        const minDistToBoundary = Math.min(minDistToNorth, minDistToSouth);
        // 距离航道中心的近似值(基于到两条边界线的距离差)
        const distFromCenter = Math.abs(minDistToNorth - minDistToSouth);
        const normalizedDist = distFromCenter / halfWidth; // 0=中心, 1=边缘

        let depth;
        if (normalizedDist < 0.4) {
          // 航道中心区域: 深水
          depth = CHANNEL_CENTER_DEPTH.min + rng() * (CHANNEL_CENTER_DEPTH.max - CHANNEL_CENTER_DEPTH.min);
        } else if (normalizedDist < 0.8) {
          // 航道中间区域: 中等深度
          const t = (normalizedDist - 0.4) / 0.4;
          const centerD = lerp(CHANNEL_CENTER_DEPTH.min, CHANNEL_CENTER_DEPTH.max, rng());
          const edgeD = lerp(CHANNEL_EDGE_DEPTH.min, CHANNEL_EDGE_DEPTH.max, rng());
          depth = lerp(centerD, edgeD, t);
        } else if (minDistToBoundary < halfWidth * 1.8) {
          // 航道边缘: 浅水过渡
          const t = Math.min((minDistToBoundary - halfWidth) / (halfWidth * 0.8), 1);
          const edgeD = lerp(CHANNEL_EDGE_DEPTH.min, CHANNEL_EDGE_DEPTH.max, rng());
          depth = lerp(edgeD, OUTSIDE_DEPTH, Math.max(0, t));
        } else {
          // 航道外: 极浅
          depth = OUTSIDE_DEPTH;
        }

        rowDepths.push(depth);
      }
      depths.push(rowDepths);
    }

    // 步骤5: 创建 PlaneGeometry 并应用深度和颜色
    // 水面凹陷效果：深度为负值，乘以 DEPTH_EXAGGERATION 后 Y轴偏移使地形下凹
    const tWidth = gridMaxX - gridMinX;
    const tHeight = gridMaxZ - gridMinZ;
    const geometry = new THREE.PlaneGeometry(tWidth, tHeight, gridSize - 1, gridSize - 1);
    geometry.rotateX(-Math.PI / 2); // 旋转使平面水平（XZ平面），法线朝Y+

    const positions = geometry.attributes.position;
    const colors = new Float32Array(positions.count * 3);

    // 遍历每个顶点，设置Y轴高度和顶点颜色
    for (let row = 0; row < gridSize; row++) {
      for (let col = 0; col < gridSize; col++) {
        const vi = row * gridSize + col;
        const depth = depths[row][col];

        // 水深直接映射为Y轴偏移
        // depth范围: -12(深水) 到 -0.5(浅水) 到 0(水面)
        // Y轴: 深水处Y值最低(凹陷), 浅水处Y值接近水面
        const terrainY = depth * DEPTH_EXAGGERATION; // depth是负值，所以深水Y更低
        positions.setY(vi, terrainY);

        const color = depthToColor(depth);
        colors[vi * 3] = color.r;
        colors[vi * 3 + 1] = color.g;
        colors[vi * 3 + 2] = color.b;
      }
    }

    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    positions.needsUpdate = true;

    // 材质: MeshBasicMaterial不受灯光影响，直接显示顶点颜色
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.DoubleSide
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    mesh.position.set((gridMinX + gridMaxX) / 2, 0, (gridMinZ + gridMaxZ) / 2);

    const meta = { gridMinX, gridMaxX, gridMinZ, gridMaxZ, stepX, stepZ, gridWidth: gridSize, gridHeight: gridSize, centerLat, centerLng, halfWidth };

    // 返回深度数据供全航道合并使用（BUG-1修复）
    return { mesh, meta, depths };
  }

  /**
   * 相机聚焦到全航道
   * @private
   */
  _focusFullChannel() {
    if (!this._depthGridMeta || !this.camera || !this.controls) return;
    const meta = this._depthGridMeta;
    const centerX = (meta.gridMinX + meta.gridMaxX) / 2;
    const centerZ = (meta.gridMinZ + meta.gridMaxZ) / 2;
    const rangeX = meta.gridMaxX - meta.gridMinX;
    const rangeZ = meta.gridMaxZ - meta.gridMinZ;
    const maxRange = Math.max(rangeX, rangeZ);

    // 水下模式相机从斜上方看
    // target在水面，高度适中
    const height = maxRange * 0.18;
    const offsetZ = maxRange * 0.25;

    // 销毁并重建 OrbitControls 以彻底重置内部球面坐标
    if (this.controls) {
      this.controls.dispose();
    }
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.maxPolarAngle = Math.PI / 2.1;
    this.controls.minDistance = 100;
    this.controls.maxDistance = 100000;
    this.controls.target.set(centerX, WATER_LEVEL_Y, centerZ);
    this.camera.position.set(
      centerX,
      height,
      centerZ + offsetZ
    );
    this.camera.lookAt(centerX, WATER_LEVEL_Y, centerZ);
    this.controls.update();
    // 位置设置完成后启用damping
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    this.camera.updateProjectionMatrix();

    console.log(`[Channel3D] 全航道水下相机: pos=[${this.camera.position.x.toFixed(0)}, ${this.camera.position.y.toFixed(0)}, ${this.camera.position.z.toFixed(0)}], target=[${this.controls.target.x.toFixed(0)}, ${this.controls.target.y.toFixed(0)}, ${this.controls.target.z.toFixed(0)}], range=${maxRange.toFixed(0)}m`);
  }

  /* ===== 构建地形（单航段模式） ===== */

  /**
   * 构建指定航段的三维地形（单航段视图模式）
   * 生成规则网格深度数据，创建带顶点着色的 PlaneGeometry
   * 并缓存深度数据供船舶吃水检测使用
   *
   * @param {object} channelData - 航道数据(含 north_boundary, south_boundary)
   * @param {number|string} segId - 航段 ID
   */
  buildTerrain(channelData, segId) {
    // 清除旧地形
    this._clearGroup(this.terrainGroup);

    if (!channelData || !channelData.north_boundary || !channelData.south_boundary) {
      console.warn('[Channel3D] 航道数据无效, 无法构建地形');
      return;
    }

    this.currentSegId = segId;

    // 生成深度网格
    const { depths, meta } = this.generateDepthGrid(
      channelData.north_boundary,
      channelData.south_boundary,
      TERRAIN_GRID,
      TERRAIN_GRID
    );

    if (!depths || depths.length === 0) return;

    // 缓存深度数据(用于船舶吃水检测)
    this._depthGridMeta = meta;

    // 创建 PlaneGeometry
    const width = meta.gridMaxX - meta.gridMinX;
    const height = meta.gridMaxZ - meta.gridMinZ;
    const geometry = new THREE.PlaneGeometry(width, height, TERRAIN_GRID - 1, TERRAIN_GRID - 1);
    geometry.rotateX(-Math.PI / 2); // 使平面水平

    // 位移顶点并设置顶点颜色
    const positions = geometry.attributes.position;
    const colors = new Float32Array(positions.count * 3);

    // 展平深度数据为一维数组以便索引
    this._depthGridData = new Float32Array(TERRAIN_GRID * TERRAIN_GRID);

    for (let row = 0; row < TERRAIN_GRID; row++) {
      for (let col = 0; col < TERRAIN_GRID; col++) {
        const vertexIndex = row * TERRAIN_GRID + col;
        const depth = depths[row][col];

        // 保存深度数据
        this._depthGridData[vertexIndex] = depth;

        // 水深直接映射为Y轴偏移
        const terrainY = depth * DEPTH_EXAGGERATION; // depth是负值，所以深水Y更低
        positions.setY(vertexIndex, terrainY);

        // 设置顶点颜色
        const color = depthToColor(depth);
        colors[vertexIndex * 3] = color.r;
        colors[vertexIndex * 3 + 1] = color.g;
        colors[vertexIndex * 3 + 2] = color.b;
      }
    }

    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    positions.needsUpdate = true;

    // 材质: MeshBasicMaterial不受灯光影响，直接显示顶点颜色
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    mesh.position.set(
      (meta.gridMinX + meta.gridMaxX) / 2,
      0,
      (meta.gridMinZ + meta.gridMaxZ) / 2
    );

    this.terrainGroup.add(mesh);
    this.currentSegment = { channelData, segId, meta };
    // 保存参考点供其他方法使用
    this._refLat = meta.centerLat;
    this._refLng = meta.centerLng;

    console.log(`[Channel3D] 地形构建完成, 航段 ${segId}, 网格 ${TERRAIN_GRID}x${TERRAIN_GRID}`);
  }

  /* ===== 构建水面 ===== */

  /**
   * 构建半透明水面平面
   * 水面使用 MeshStandardMaterial，具有一定的金属感和粗糙度，
   * 透明度0.35使水下地形可透视。水面位置固定在 Y=WATER_LEVEL_Y，
   * 在动画循环中通过 _animateWater() 方法使顶点产生微波起伏效果
   *
   * 支持三种边界来源:
   *   1. bounds.north_boundary + bounds.south_boundary (边界点坐标)
   *   2. bounds.minX/maxX/minZ/maxZ (局部坐标范围)
   *   3. 使用当前航段的元数据范围
   *   4. 默认2000x2000m范围
   *
   * @param {object} bounds - 边界信息，支持多种格式
   */
  buildWaterSurface(bounds) {
    this._clearGroup(this.waterGroup);

    let minX, maxX, minZ, maxZ;

    if (bounds && bounds.north_boundary && bounds.south_boundary) {
      // 从边界点计算范围
      const allPts = [...bounds.north_boundary, ...bounds.south_boundary];
      const localPts = allPts.map(p => geoToLocal(p[0], p[1], this._refLat, this._refLng));
      minX = Math.min(...localPts.map(p => p.x)) - 200;
      maxX = Math.max(...localPts.map(p => p.x)) + 200;
      minZ = Math.min(...localPts.map(p => p.z)) - 200;
      maxZ = Math.max(...localPts.map(p => p.z)) + 200;
    } else if (bounds && bounds.minX !== undefined) {
      minX = bounds.minX;
      maxX = bounds.maxX;
      minZ = bounds.minZ;
      maxZ = bounds.maxZ;
    } else if (this.currentSegment && this.currentSegment.meta) {
      const m = this.currentSegment.meta;
      minX = m.gridMinX;
      maxX = m.gridMaxX;
      minZ = m.gridMinZ;
      maxZ = m.gridMaxZ;
    } else {
      minX = -1000; maxX = 1000;
      minZ = -1000; maxZ = 1000;
    }

    const width = maxX - minX;
    const height = maxZ - minZ;

    // 水面使用较高分辨率以获得平滑波浪 (优化: 48->64)
    const waterGrid = TERRAIN_GRID;
    const geometry = new THREE.PlaneGeometry(width, height, waterGrid, waterGrid);
    geometry.rotateX(-Math.PI / 2);

    const material = new THREE.MeshStandardMaterial({
      color: 0x1a6090,
      transparent: true,
      opacity: 0.35,
      roughness: 0.1,
      metalness: 0.5,
      side: THREE.DoubleSide,
      depthWrite: false
    });

    const mesh = new THREE.Mesh(geometry, material);
    // 水面固定在Y=0
    mesh.position.set(
      (minX + maxX) / 2,
      WATER_LEVEL_Y,
      (minZ + maxZ) / 2
    );

    this.waterGroup.add(mesh);
  }

  /* ===== 构建船舶 ===== */

  /**
   * 在场景中放置船舶三维模型（单航段视图模式的入口方法）
   * 清除旧船舶后调用 _buildShipModels() 批量创建船舶 Mesh
   *
   * @param {Array} ships - 船舶数据数组，每项含 lat, lng, length, width, heading, draft 等
   * @param {number|string} segId - 航段 ID
   */
  buildShips(ships, segId) {
    this._clearGroup(this.shipGroup);
    this._lastShips = ships;
    this._isFullChannel = false;

    if (!ships || ships.length === 0) return;

    this._buildShipModels(ships);
  }

  /**
   * 构建简化船舶标记（用于全航道简化模式）
   * 使用小球体+竖线表示船舶位置，避免深度网格依赖
   * @param {Array} ships - 船舶数据
   * @param {number} centerLat - 中心纬度
   * @param {number} centerLng - 中心经度
   * @private
   */
  _buildSimplifiedShipMarkers(ships, centerLat, centerLng) {
    if (!this.shipGroup) {
      this.shipGroup = new THREE.Group();
      this.scene.add(this.shipGroup);
    }

    ships.forEach(ship => {
      const shipLat = ship._lat !== undefined ? ship._lat : ship.lat;
      const shipLng = ship._lng !== undefined ? ship._lng : ship.lng;
      if (shipLat === undefined || shipLng === undefined) return;

      const local = geoToLocal(shipLat, shipLng, centerLat, centerLng);

      // 小球体标记
      const isConstruction = ship.type === 'construction';
      const color = isConstruction ? 0xff6b35 : 0x00d4ff;
      const markerGeo = new THREE.SphereGeometry(80, 8, 8);
      const markerMat = new THREE.MeshBasicMaterial({ color: color });
      const marker = new THREE.Mesh(markerGeo, markerMat);
      marker.position.set(local.x, WATER_LEVEL_Y + 50, local.z);
      marker.userData = { type: 'ship', shipData: ship, part: 'marker' };
      this.shipGroup.add(marker);

      // 竖线（从水面到标记点）
      const lineGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(local.x, WATER_LEVEL_Y, local.z),
        new THREE.Vector3(local.x, WATER_LEVEL_Y + 50, local.z)
      ]);
      const lineMat = new THREE.LineBasicMaterial({ color: color, transparent: true, opacity: 0.5 });
      const line = new THREE.Line(lineGeo, lineMat);
      this.shipGroup.add(line);
    });
  }

  /**
   * 构建船舶3D模型(水上部分 + 水下船体)
   * 水上部分: 船体上部(灰色/红色)，露出水面的干舷
   * 水下部分: 船体下部(深色)，延伸到吃水深度
   * @param {Array} ships - 船舶数据
   * @private
   */
  /**
   * 为每艘船舶构建三维模型并添加到 shipGroup
   *
   * 船舶模型组成:
   *   - 水下船体: BoxGeometry，蓝色(正常) 或 红色(搁浅)，位于水面以下
   *   - 水上船体: BoxGeometry，灰色/白色，位于水面以上（干舷）
   *   - 驾驶室: BoxGeometry，位于船体上方
   *   - 搁浅标记: 红色竖线（当吃水>水深时）
   *
   * 船舶缩放策略:
   *   - 全航道模式(>20km场景): 船舶占场景约5%可见度，最小3倍放大
   *   - 航段立体模式: 船舶占航道长度8%~15%，缩放范围0.8~2.5倍
   *
   * @param {Array} ships - 船舶数据数组，每项含 lat/lng/length/width/heading/draft 等
   * @private
   */
  _buildShipModels(ships) {
    const meta = this.currentSegment ? this.currentSegment.meta : null;
    if (!meta) return;

    ships.forEach((ship, index) => {
      let shipLocalX, shipLocalZ;

      // 获取船舶位置（优先使用 _lat/_lng 兼容字段，其次 lat/lng）
      const shipLat = ship._lat !== undefined ? ship._lat : ship.lat;
      const shipLng = ship._lng !== undefined ? ship._lng : ship.lng;
      if (shipLat !== undefined && shipLng !== undefined) {
        const local = geoToLocal(shipLat, shipLng, meta.centerLat, meta.centerLng);
        shipLocalX = local.x;
        shipLocalZ = local.z;
      } else {
        return;
      }

      // 船舶基本参数（默认80m长、15m宽）
      const shipLength = ship.length || 80;
      const shipWidth = ship.width || 15;

      // 计算吃水深度（优先外部数据 > 船舶自带数据 > 按船长估算）
      const draft = calculateDraft(ship, this._externalDraftData);

      // 获取船舶所在位置的水深，判断是否搁浅
      const waterDepth = this._getDepthAtPosition(shipLocalX, shipLocalZ);
      const isGrounding = draft > Math.abs(waterDepth); // 吃水大于水深 = 搁浅

      // 缩放因子
      const sceneRange = Math.max(
        Math.abs(meta.gridMaxX - meta.gridMinX),
        Math.abs(meta.gridMaxZ - meta.gridMinZ)
      );
      let scaleFactor;
      if (this._isFullChannel && sceneRange > 20000) {
        // 全航道模式：让船舶在76km场景中占约5%的可见度
        scaleFactor = sceneRange * 0.05 / Math.max(shipLength, 1);
        scaleFactor = Math.max(scaleFactor, 3);
      } else {
        // 航段立体模式：按航段大小比例缩放，确保船舶大小与航道匹配
        // 船舶长度应占航道长度的 8%-15%
        scaleFactor = Math.max(sceneRange * 0.12 / Math.max(shipLength, 1), 0.8);
        // 限制最大缩放，避免船舶过大
        scaleFactor = Math.min(scaleFactor, 2.5);
      }
      const scaledLength = shipLength * scaleFactor;
      const scaledWidth = shipWidth * scaleFactor;
      const scaledDraft = draft * scaleFactor;

      // 航向
      const heading = ship.heading !== undefined ? ship.heading : 0;
      const headingRad = -heading * Math.PI / 180;

      // 水面高度统一使用 WATER_LEVEL_Y
      const waterY = WATER_LEVEL_Y;

      // ===== 剖视图模式下使用更精细的船舶模型 =====
      if (this._isCrossSection) {
        this._buildDetailedShipModel(ship, shipLocalX, shipLocalZ, waterY, scaledLength, scaledWidth, scaledDraft, draft, headingRad, isGrounding, waterDepth);
      } else {
        // ===== 全航道模式：简化船舶模型 =====
        // 水下船体(标准材质，支持阴影)
        const underwaterHeight = Math.max(scaledDraft, 2);
        const underwaterGeo = new THREE.BoxGeometry(scaledLength, underwaterHeight, scaledWidth);
        const underwaterColor = isGrounding ? 0xcc2200 : 0x2266aa;
        const underwaterMat = new THREE.MeshStandardMaterial({
          color: underwaterColor, transparent: true, opacity: 0.9,
          roughness: 0.6, metalness: 0.3
        });
        const underwaterMesh = new THREE.Mesh(underwaterGeo, underwaterMat);
        underwaterMesh.position.set(shipLocalX, waterY - underwaterHeight / 2, shipLocalZ);
        underwaterMesh.rotation.y = headingRad;
        underwaterMesh.castShadow = true;
        underwaterMesh.receiveShadow = true;
        underwaterMesh.userData = { type: 'ship', shipData: ship, part: 'underwater' };
        this.shipGroup.add(underwaterMesh);

        // 水上船体(标准材质)
        const freeboardHeight = Math.max(scaledLength * 0.06, 2);
        const aboveGeo = new THREE.BoxGeometry(scaledLength * 0.95, freeboardHeight, scaledWidth * 0.9);
        const aboveColor = isGrounding ? 0xff3333 : 0x4488aa;
        const aboveMat = new THREE.MeshStandardMaterial({ color: aboveColor, roughness: 0.5, metalness: 0.2 });
        const aboveMesh = new THREE.Mesh(aboveGeo, aboveMat);
        aboveMesh.position.set(shipLocalX, waterY + freeboardHeight / 2, shipLocalZ);
        aboveMesh.rotation.y = headingRad;
        aboveMesh.userData = { type: 'ship', shipData: ship, part: 'abovewater' };
        this.shipGroup.add(aboveMesh);

        // 驾驶室
        const bridgeW = scaledWidth * 0.5;
        const bridgeH = Math.max(freeboardHeight * 1.5, 3);
        const bridgeL = scaledLength * 0.15;
        const bridgeGeo = new THREE.BoxGeometry(bridgeL, bridgeH, bridgeW);
        const bridgeMat = new THREE.MeshBasicMaterial({ color: 0xccddee });
        const bridgeMesh = new THREE.Mesh(bridgeGeo, bridgeMat);
        const bridgeOffset = scaledLength * 0.35;
        bridgeMesh.position.set(
          shipLocalX + Math.sin(headingRad) * bridgeOffset,
          waterY + freeboardHeight + bridgeH / 2,
          shipLocalZ + Math.cos(headingRad) * bridgeOffset
        );
        bridgeMesh.rotation.y = headingRad;
        bridgeMesh.userData = { type: 'ship', shipData: ship, part: 'bridge' };
        this.shipGroup.add(bridgeMesh);

        // 水线标记
        const waterlineGeo = new THREE.BoxGeometry(scaledLength * 1.02, 0.5, scaledWidth * 1.02);
        const waterlineMat = new THREE.MeshBasicMaterial({
          color: isGrounding ? 0xff0000 : SCAN_LIGHT_COLOR, transparent: true, opacity: 0.8
        });
        const waterlineMesh = new THREE.Mesh(waterlineGeo, waterlineMat);
        waterlineMesh.position.set(shipLocalX, waterY, shipLocalZ);
        waterlineMesh.rotation.y = headingRad;
        waterlineMesh.userData = { type: 'ship', shipData: ship, part: 'waterline' };
        this.shipGroup.add(waterlineMesh);

        // 搁浅警告
        if (isGrounding) {
          this._addGroundingWarning(shipLocalX, waterY + scaledLength * 0.1, shipLocalZ, scaledWidth);
        }

        // 船名标签
        const labelHeight = scaledLength * 1.2 + 40;
        this._addShipLabel(ship.name || `Ship ${index + 1}`, shipLocalX, waterY + labelHeight, shipLocalZ, true);
      }

      console.log(
        `[Channel3D] 船舶 "${ship.name || 'Unknown'}": 吃水=${draft.toFixed(1)}m, ` +
        `水深=${Math.abs(waterDepth).toFixed(1)}m${isGrounding ? ' [搁浅警告!]' : ''}`
      );
    });
  }

  /**
   * 获取指定位置的水深（双线性插值）
   * @param {number} x - 局部 x 坐标
   * @param {number} z - 局部 z 坐标
   * @returns {number} 水深(负值)
   * @private
   */
  _getDepthAtPosition(x, z) {
    if (!this._depthGridMeta || !this._depthGridData) return -6;

    const meta = this._depthGridMeta;
    const fx = (x - meta.gridMinX) / meta.stepX;
    const fy = (z - meta.gridMinZ) / meta.stepZ;

    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = x0 + 1;
    const y1 = y0 + 1;

    const sx = fx - x0;
    const sy = fy - y0;

    const w = meta.gridWidth;
    const h = meta.gridHeight;

    // 边界处理
    const ix0 = Math.max(0, Math.min(x0, w - 1));
    const iy0 = Math.max(0, Math.min(y0, h - 1));
    const ix1 = Math.max(0, Math.min(x1, w - 1));
    const iy1 = Math.max(0, Math.min(y1, h - 1));

    const d00 = this._depthGridData[iy0 * w + ix0];
    const d10 = this._depthGridData[iy0 * w + ix1];
    const d01 = this._depthGridData[iy1 * w + ix0];
    const d11 = this._depthGridData[iy1 * w + ix1];

    const d0 = d00 + (d10 - d00) * sx;
    const d1 = d01 + (d11 - d01) * sx;

    return d0 + (d1 - d0) * sy;
  }

  /**
   * 构建精细船舶3D模型（用于剖视图模式）
   * 新需求3：圆角船型、梯形水上部分、吃水标注、航行姿态
   * @private
   */
  _buildDetailedShipModel(ship, shipLocalX, shipLocalZ, waterY, scaledLength, scaledWidth, scaledDraft, draft, headingRad, isGrounding, waterDepth) {
    const shipGroup = new THREE.Group();
    shipGroup.userData = { type: 'ship', shipData: ship };

    // 1. 水下船体 - 圆角船型（底部收窄）
    const underwaterHeight = Math.max(scaledDraft, 2);
    const hullShape = new THREE.Shape();
    const hw = scaledWidth / 2;
    const hl = scaledLength / 2;
    // 船底轮廓（梯形截面，底部收窄）
    hullShape.moveTo(-hl, -hw * 0.6);
    hullShape.lineTo(hl, -hw * 0.6);
    hullShape.lineTo(hl, hw * 0.6);
    hullShape.lineTo(-hl, hw * 0.6);
    hullShape.closePath();

    const hullGeo = new THREE.ExtrudeGeometry(hullShape, {
      depth: underwaterHeight,
      bevelEnabled: true,
      bevelThickness: 1,
      bevelSize: 1,
      bevelSegments: 2
    });
    hullGeo.rotateX(Math.PI / 2);
    const hullColor = isGrounding ? 0xcc2200 : 0x2266aa;
    const hullMat = new THREE.MeshBasicMaterial({
      color: hullColor, transparent: true, opacity: 0.85
    });
    const hullMesh = new THREE.Mesh(hullGeo, hullMat);
    hullMesh.position.set(shipLocalX, waterY - underwaterHeight / 2, shipLocalZ);
    hullMesh.rotation.y = headingRad;
    shipGroup.add(hullMesh);

    // 2. 水上船体 - 梯形（上宽下窄）
    const freeboardHeight = Math.max(scaledLength * 0.08, 3);
    const aboveShape = new THREE.Shape();
    const ahw = scaledWidth * 0.55 / 2; // 水上部分稍宽
    const ahl = scaledLength * 0.95 / 2;
    aboveShape.moveTo(-ahl, -ahw);
    aboveShape.lineTo(ahl, -ahw);
    aboveShape.lineTo(ahl * 0.9, ahw);
    aboveShape.lineTo(-ahl * 0.9, ahw);
    aboveShape.closePath();

    const aboveGeo = new THREE.ExtrudeGeometry(aboveShape, {
      depth: freeboardHeight,
      bevelEnabled: true,
      bevelThickness: 0.5,
      bevelSize: 0.5,
      bevelSegments: 2
    });
    aboveGeo.rotateX(Math.PI / 2);
    const aboveColor = isGrounding ? 0xff3333 : 0x4488aa;
    const aboveMat = new THREE.MeshBasicMaterial({ color: aboveColor });
    const aboveMesh = new THREE.Mesh(aboveGeo, aboveMat);
    aboveMesh.position.set(shipLocalX, waterY + freeboardHeight / 2, shipLocalZ);
    aboveMesh.rotation.y = headingRad;
    shipGroup.add(aboveMesh);

    // 3. 船首（尖锐形状）
    const bowShape = new THREE.Shape();
    bowShape.moveTo(0, -ahw * 0.8);
    bowShape.lineTo(hl * 0.3, 0);
    bowShape.lineTo(0, ahw * 0.8);
    bowShape.closePath();
    const bowGeo = new THREE.ExtrudeGeometry(bowShape, {
      depth: freeboardHeight * 1.1,
      bevelEnabled: false
    });
    bowGeo.rotateX(Math.PI / 2);
    const bowMat = new THREE.MeshBasicMaterial({ color: aboveColor });
    const bowMesh = new THREE.Mesh(bowGeo, bowMat);
    const bowOffset = hl * 0.85;
    bowMesh.position.set(
      shipLocalX + Math.cos(headingRad) * bowOffset,
      waterY + freeboardHeight * 0.55,
      shipLocalZ - Math.sin(headingRad) * bowOffset
    );
    bowMesh.rotation.y = headingRad;
    shipGroup.add(bowMesh);

    // 4. 驾驶室/上层建筑（多层结构）
    const bridgeW = scaledWidth * 0.45;
    const bridgeH = Math.max(freeboardHeight * 1.8, 5);
    const bridgeL = scaledLength * 0.12;
    const bridgeGeo = new THREE.BoxGeometry(bridgeL, bridgeH, bridgeW);
    const bridgeMat = new THREE.MeshBasicMaterial({ color: 0xccddee });
    const bridgeMesh = new THREE.Mesh(bridgeGeo, bridgeMat);
    const bridgeOffset = scaledLength * 0.3;
    bridgeMesh.position.set(
      shipLocalX + Math.sin(headingRad) * bridgeOffset,
      waterY + freeboardHeight + bridgeH / 2,
      shipLocalZ + Math.cos(headingRad) * bridgeOffset
    );
    bridgeMesh.rotation.y = headingRad;
    shipGroup.add(bridgeMesh);

    // 5. 雷达/天线杆
    const antennaGeo = new THREE.CylinderGeometry(0.3, 0.3, bridgeH * 0.6, 6);
    const antennaMat = new THREE.MeshBasicMaterial({ color: 0x8899aa });
    const antennaMesh = new THREE.Mesh(antennaGeo, antennaMat);
    antennaMesh.position.set(
      shipLocalX + Math.sin(headingRad) * bridgeOffset,
      waterY + freeboardHeight + bridgeH + bridgeH * 0.3,
      shipLocalZ + Math.cos(headingRad) * bridgeOffset
    );
    shipGroup.add(antennaMesh);

    // 6. 水线标记（发光环）
    const waterlineRingGeo = new THREE.RingGeometry(scaledLength * 0.48, scaledLength * 0.52, 32);
    waterlineRingGeo.rotateX(-Math.PI / 2);
    const waterlineRingMat = new THREE.MeshBasicMaterial({
      color: isGrounding ? 0xff0000 : SCAN_LIGHT_COLOR,
      transparent: true, opacity: 0.7, side: THREE.DoubleSide
    });
    const waterlineRing = new THREE.Mesh(waterlineRingGeo, waterlineRingMat);
    waterlineRing.position.set(shipLocalX, waterY + 0.5, shipLocalZ);
    waterlineRing.rotation.y = headingRad;
    shipGroup.add(waterlineRing);

    // 7. 吃水深度标注（3D文字标签）
    const draftLabel = this._createDraftLabel(`${draft.toFixed(1)}m`, shipLocalX, waterY - underwaterHeight - 5, shipLocalZ, isGrounding ? 0xff4444 : 0x00d4ff);
    if (draftLabel) shipGroup.add(draftLabel);

    // 8. 搁浅警告
    if (isGrounding) {
      const warnGroup = this._addGroundingWarning(shipLocalX, waterY + scaledLength * 0.15, shipLocalZ, scaledWidth);
      if (warnGroup) shipGroup.add(warnGroup);
    }

    // 9. 船名标签
    const labelSprite = this._addShipLabel(ship.name || '船舶', shipLocalX, waterY + freeboardHeight + bridgeH + 15, shipLocalZ, false);
    if (labelSprite) shipGroup.add(labelSprite);

    // 10. 航行姿态指示（航向箭头）
    const arrowLen = scaledLength * 0.4;
    const arrowGeo = new THREE.ConeGeometry(1.5, arrowLen, 8);
    arrowGeo.rotateX(Math.PI / 2);
    const arrowMat = new THREE.MeshBasicMaterial({
      color: 0x00ff88, transparent: true, opacity: 0.5
    });
    const arrowMesh = new THREE.Mesh(arrowGeo, arrowMat);
    arrowMesh.position.set(
      shipLocalX + Math.cos(headingRad) * arrowLen * 0.6,
      waterY + 2,
      shipLocalZ - Math.sin(headingRad) * arrowLen * 0.6
    );
    arrowMesh.rotation.y = headingRad;
    shipGroup.add(arrowMesh);

    this._crossSectionGroup.add(shipGroup);
  }

  /**
   * 创建吃水深度标注标签
   * @private
   */
  _createDraftLabel(text, x, y, z, color) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 128;
    canvas.height = 48;

    const colorStr = typeof color === 'number' ? '#' + color.toString(16).padStart(6, '0') : color;

    ctx.fillStyle = 'rgba(0, 20, 40, 0.8)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = colorStr;
    ctx.lineWidth = 1;
    ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);

    ctx.shadowColor = colorStr;
    ctx.shadowBlur = 6;
    ctx.fillStyle = colorStr;
    ctx.font = 'bold 18px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    const spriteMaterial = new THREE.SpriteMaterial({
      map: texture, transparent: true, depthWrite: false
    });
    const sprite = new THREE.Sprite(spriteMaterial);
    sprite.position.set(x, y, z);
    sprite.scale.set(40, 15, 1);
    return sprite;
  }

  /**
   * 添加搁浅警告光环
   * @private
   */
  _addGroundingWarning(x, y, z, shipWidth) {
    const ringGeometry = new THREE.RingGeometry(shipWidth * 0.8, shipWidth * 1.2, 32);
    ringGeometry.rotateX(-Math.PI / 2);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0xff0000,
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.position.set(x, y, z);

    // 点光源(红色闪烁效果)
    const pointLight = new THREE.PointLight(0xff3300, 2, 100);
    pointLight.position.set(x, y + 5, z);

    // 如果是剖视图模式，返回Group以便外部添加到_crossSectionGroup
    if (this._isCrossSection) {
      const group = new THREE.Group();
      group.add(ring);
      group.add(pointLight);
      return group;
    } else {
      this.shipGroup.add(ring);
      this.shipGroup.add(pointLight);
      return null;
    }
  }

  /**
   * 添加船舶名称标签
   * @private
   */
  _addShipLabel(name, x, y, z, large = false) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    // 全航道模式下标签更大更清晰
    canvas.width = large ? 800 : 512;
    canvas.height = large ? 200 : 128;

    ctx.fillStyle = 'rgba(0, 20, 40, 0.8)';
    // roundRect 兼容性处理
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(0, 0, canvas.width, canvas.height, 20);
      ctx.fill();
    } else {
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // 边框
    ctx.strokeStyle = 'rgba(0, 212, 255, 0.5)';
    ctx.lineWidth = large ? 3 : 2;
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(2, 2, canvas.width - 4, canvas.height - 4, 18);
      ctx.stroke();
    }

    // 发光效果
    ctx.shadowColor = '#00d4ff';
    ctx.shadowBlur = large ? 16 : 8;
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${large ? 56 : 36}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, canvas.width / 2, canvas.height / 2);
    // 二次绘制增强发光
    ctx.shadowBlur = large ? 28 : 12;
    ctx.fillText(name, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    const spriteMaterial = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false
    });
    const sprite = new THREE.Sprite(spriteMaterial);
    sprite.position.set(x, y, z);
    // 全航道模式下标签更大
    sprite.scale.set(large ? 400 : 80, large ? 100 : 20, 1);
    // 剖视图模式下直接返回sprite，不添加到shipGroup
    if (this._isCrossSection) {
      return sprite;
    }
    this.shipGroup.add(sprite);
  }

  /* ===== 构建航道边界线 ===== */

  /**
   * 绘制航道边界三维线条
   * @param {object} channelData - 航道数据
   * @param {number|string} segId - 航段 ID
   */
  buildChannelBounds(channelData, segId) {
    this._clearGroup(this.boundaryGroup);

    if (!channelData) return;

    const meta = this.currentSegment ? this.currentSegment.meta : null;
    if (!meta) {
      console.warn('[Channel3D] 无航段元数据, 无法绘制边界');
      return;
    }

    const boundaries = [
      { points: channelData.north_boundary, color: 0x00ff88, label: '北界' },
      { points: channelData.south_boundary, color: 0xff8800, label: '南界' }
    ];

    if (channelData.centerline) {
      boundaries.push({ points: channelData.centerline, color: 0xffff00, label: '中线' });
    }

    boundaries.forEach(({ points, color, label }) => {
      if (!points || points.length < 2) return;

      const localPoints = points.map(p => geoToLocal(p[0], p[1], meta.centerLat, meta.centerLng));

      // 创建线条几何体
      const lineVertices = [];
      const lineY = WATER_LEVEL_Y + 3;
      localPoints.forEach(p => {
        lineVertices.push(p.x, lineY, p.z);
      });

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(lineVertices, 3));

      const material = new THREE.LineBasicMaterial({
        color: color,
        linewidth: 2,
        transparent: true,
        opacity: 0.9
      });

      const line = new THREE.Line(geometry, material);
      this.boundaryGroup.add(line);

      // 在边界线上添加浮标标记(每隔若干点)
      const buoyInterval = Math.max(Math.floor(localPoints.length / 5), 1);
      for (let i = 0; i < localPoints.length; i += buoyInterval) {
        this._addBuoy(localPoints[i].x, WATER_Y + 2, localPoints[i].z, color);
      }
    });

    console.log(`[Channel3D] 航道边界线绘制完成, 航段 ${segId}`);
  }

  /**
   * 添加浮标标记
   * @private
   */
  _addBuoy(x, y, z, color) {
    const buoyGeometry = new THREE.SphereGeometry(3, 12, 8);
    const buoyMaterial = new THREE.MeshStandardMaterial({
      color: color,
      emissive: color,
      emissiveIntensity: 0.8,
      roughness: 0.3,
      metalness: 0.7
    });
    const buoy = new THREE.Mesh(buoyGeometry, buoyMaterial);
    buoy.position.set(x, y, z);
    buoy.castShadow = true;
    this.boundaryGroup.add(buoy);

    // 浮标杆
    const poleGeometry = new THREE.CylinderGeometry(0.5, 0.5, 8, 6);
    const poleMaterial = new THREE.MeshStandardMaterial({ color: 0x888888, metalness: 0.8 });
    const pole = new THREE.Mesh(poleGeometry, poleMaterial);
    pole.position.set(x, y - 4, z);
    this.boundaryGroup.add(pole);
  }

  /* ===== 航段聚焦 ===== */

  /**
   * 平滑飞行到指定位置（公共方法，可被外部调用）
   * @param {object} target - 目标位置 { x, y, z }（Three.js局部坐标）
   * @param {number} duration - 飞行持续时间(ms)，默认2000
   */
  flyTo(target, duration = 2000) {
    if (!this.camera || !this.controls) return;
    this._cameraAnim = {
      fromPos: this.camera.position.clone(),
      toPos: new THREE.Vector3(target.x + 300, target.y + 600, target.z + 300),
      fromTarget: this.controls.target.clone(),
      toTarget: new THREE.Vector3(target.x, target.y, target.z),
      startTime: performance.now(),
      duration: duration,
      easeFn: this._easeOutExpo
    };
  }

  /* ===== CSS2D 3D浮动标签 ===== */

  /* ===== 自动巡航模式 ===== */

  /**
   * 启动自动巡航模式
   * @param {Array} segments - 航段列表 [{ center: [lat,lng], name, risk }, ...]
   * @param {number} interval - 每个航段停留时间(ms)，默认5000
   */
  startAutoTour(segments, interval = 5000) {
    if (!segments || segments.length === 0) return;
    this._isAutoTour = true;
    this._tourSegments = segments;
    this._tourInterval = interval;
    this._tourIndex = 0;
    this._flyToNextTourTarget();
  }

  /**
   * 停止自动巡航
   */
  stopAutoTour() {
    this._isAutoTour = false;
    if (this._tourTimer) {
      clearTimeout(this._tourTimer);
      this._tourTimer = null;
    }
  }

  /**
   * 巡航内部：飞行到下一个航段
   * @private
   */
  _flyToNextTourTarget() {
    if (!this._isAutoTour || !this._tourSegments) return;

    const seg = this._tourSegments[this._tourIndex % this._tourSegments.length];
    if (seg && seg.center && this._refLat) {
      const local = geoToLocal(seg.center[0], seg.center[1], this._refLat, this._refLng);
      this.flyTo({ x: local.x, y: 10, z: local.z }, 2500);
    }

    this._tourTimer = setTimeout(() => {
      this._tourIndex++;
      this._flyToNextTourTarget();
    }, this._tourInterval);
  }

  /**
   * 为航段创建3D浮动标签（CSS2DObject）
   * @param {string} name - 航段名称
   * @param {number} localX - 局部X坐标
   * @param {number} localY - 局部Y坐标
   * @param {number} localZ - 局部Z坐标
   * @param {number} risk - 风险值
   * @returns {CSS2DObject} 标签对象
   * @private
   */
  _createSegmentCSS2DLabel(name, localX, localY, localZ, risk) {
    const div = document.createElement('div');
    div.className = 'three-segment-label';
    div.innerHTML = `<div class="label-name">${name}</div><div class="label-risk">${risk.toFixed(2)}</div>`;
    div.style.cssText = `
      background: rgba(10,22,40,0.85); border: 1px solid rgba(0,212,255,0.4);
      border-radius: 6px; padding: 4px 10px; color: #c0d8f0;
      font-size: 11px; font-family: 'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;
      white-space: nowrap; pointer-events: none;
      box-shadow: 0 0 10px rgba(0,180,255,0.15);
      transform: translate(-50%, -100%);
    `;
    const label = new CSS2DObject(div);
    label.position.set(localX, localY + 15, localZ);
    return label;
  }

  /**
   * 为船舶创建3D浮动标签（CSS2DObject）
   * @param {string} name - 船舶名称
   * @param {string} type - 船舶类型
   * @param {number} localX - 局部X坐标
   * @param {number} localY - 局部Y坐标
   * @param {number} localZ - 局部Z坐标
   * @returns {CSS2DObject} 标签对象
   * @private
   */
  _createShipCSS2DLabel(name, type, localX, localY, localZ) {
    const div = document.createElement('div');
    div.style.cssText = `
      background: rgba(10,22,40,0.8); border: 1px solid rgba(0,180,255,0.3);
      border-radius: 4px; padding: 2px 6px; color: #8ab4d8;
      font-size: 9px; font-family: 'Segoe UI','PingFang SC',sans-serif;
      white-space: nowrap; pointer-events: none;
      transform: translate(-50%, -100%);
    `;
    div.textContent = name;
    const label = new CSS2DObject(div);
    label.position.set(localX, localY + 8, localZ);
    return label;
  }

  /**
   * 相机动画聚焦到指定航段中心
   * 使用 ease-in-out cubic 缓动函数，1.5秒内平滑过渡相机位置和注视点
   *
   * @param {number|string} segId - 要聚焦的航段 ID
   */
  focusSegment(segId) {
    if (!this.currentSegment || !this.camera || !this.controls) return;

    const meta = this.currentSegment.meta;
    const centerX = (meta.gridMinX + meta.gridMaxX) / 2;
    const centerZ = (meta.gridMinZ + meta.gridMaxZ) / 2;
    const rangeX = meta.gridMaxX - meta.gridMinX;
    const rangeZ = meta.gridMaxZ - meta.gridMinZ;
    const maxRange = Math.max(rangeX, rangeZ);

    // 目标相机位置: 偏上方俯视，距离与场景大小成比例
    const dist = maxRange * 0.8;
    const height = maxRange * 0.5;
    const targetPos = new THREE.Vector3(
      centerX + dist * 0.3,
      height,
      centerZ + dist * 0.4
    );
    const targetLookAt = new THREE.Vector3(centerX, -2, centerZ);

    // 启动动画
    this._cameraAnim = {
      fromPos: this.camera.position.clone(),
      toPos: targetPos,
      fromTarget: this.controls.target.clone(),
      toTarget: targetLookAt,
      startTime: performance.now(),
      duration: 1500 // 1.5秒
    };

    console.log(`[Channel3D] 聚焦航段 ${segId}, 场景范围: ${rangeX.toFixed(0)}x${rangeZ.toFixed(0)}m`);
  }

  /* ===== 显示/隐藏 ===== */

  /**
   * 显示 3D 视图
   * 由外部控制容器显示后调用，延迟一帧执行 resize 确保容器已完成布局
   * BUG-6修复: 确保显示后渲染器尺寸与容器一致
   */
  show() {
    // 延迟一帧确保容器已完成布局后再更新尺寸
    requestAnimationFrame(() => {
      this.resize();
    });
    console.log('[Channel3D] 3D 视图已显示');
  }

  /**
   * 隐藏 3D 视图
   * 由外部控制容器隐藏后调用，可在此暂停动画以节省资源
   */
  hide() {
    console.log('[Channel3D] 3D 视图已隐藏');
  }

  /* ===== 窗口大小适配 ===== */

  /**
   * 处理窗口/容器大小变化
   * 更新相机宽高比、投影矩阵和渲染器尺寸，避免画面变形
   * 由 window.resize 事件和 show() 方法触发
   */
  resize() {
    if (!this.container || !this.camera || !this.renderer) return;

    // 获取容器实际尺寸（默认800x600防异常）
    const width = this.container.clientWidth || 800;
    const height = this.container.clientHeight || 600;

    // 容器过小时不执行resize，避免除零或异常渲染
    if (width < 10 || height < 10) return;

    // 更新相机宽高比和投影矩阵
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    // 更新渲染器画布尺寸
    this.renderer.setSize(width, height);

    // 更新后处理管线尺寸
    if (this._composer) this._composer.setSize(width, height);
    if (this._bloomPass) this._bloomPass.resolution.set(width, height);
    if (this._fxaaPass) this._fxaaPass.uniforms['resolution'].value.set(1 / width, 1 / height);

    // 更新CSS2D标签渲染器尺寸
    if (this._labelRenderer) this._labelRenderer.setSize(width, height);
  }

  /* ===== 边界扫光动画（精确模式） ===== */

  /**
   * 初始化边界扫光动画
   * 沿航道边界线创建一个流动的发光光点和渐隐拖尾
   * 扫光路径由 _scanPath 数组提供（在 buildFullChannel 中收集）
   * @private
   */
  _initBoundaryScan() {
    // 清除旧的扫光对象
    if (this._scanLight) {
      this.boundaryGroup.remove(this._scanLight);
      this._scanLight.geometry.dispose();
      this._scanLight.material.dispose();
      this._scanLight = null;
    }
    this._scanTrail.forEach(m => {
      this.boundaryGroup.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    });
    this._scanTrail = [];
    this._scanProgress = 0;

    if (this._scanPath.length < 2) return;

    // 创建扫光光点（发光球体）
    const lightGeo = new THREE.SphereGeometry(8, 16, 12);
    const lightMat = new THREE.MeshBasicMaterial({
      color: SCAN_LIGHT_COLOR,
      transparent: true,
      opacity: 1.0
    });
    this._scanLight = new THREE.Mesh(lightGeo, lightMat);
    this.boundaryGroup.add(this._scanLight);

    // 创建拖尾（多个渐变透明球体）
    // 创建拖尾效果：15个逐渐变小、变透明的球体，形成彗星尾巴效果
    const trailCount = 15;
    for (let i = 0; i < trailCount; i++) {
      const t = i / trailCount;
      const trailGeo = new THREE.SphereGeometry(6 * (1 - t * 0.5), 8, 6);
      const trailMat = new THREE.MeshBasicMaterial({
        color: SCAN_LIGHT_COLOR,
        transparent: true,
        opacity: 0.6 * (1 - t)
      });
      const trailMesh = new THREE.Mesh(trailGeo, trailMat);
      this.boundaryGroup.add(trailMesh);
      this._scanTrail.push(trailMesh);
    }

    // 添加点光源跟随扫光
    const pointLight = new THREE.PointLight(SCAN_LIGHT_COLOR, 3, 500);
    this._scanLight.add(pointLight);

    console.log(`[Channel3D] 边界扫光初始化, 路径点: ${this._scanPath.length}`);
  }

  /**
   * 每帧更新边界扫光动画
   * 扫光沿 _scanPath 路径匀速循环移动，拖尾跟随
   * @private
   */
  _animateBoundaryScan() {
    if (!this._scanLight || this._scanPath.length < 2) return;

    // 递增扫光进度（循环 0~1）
    this._scanProgress += this._scanSpeed;
    if (this._scanProgress >= 1) this._scanProgress -= 1;

    // 在路径上插值获取当前位置
    const totalLen = this._scanPath.length - 1;
    const exactIdx = this._scanProgress * totalLen;
    const idx = Math.floor(exactIdx);
    const t = exactIdx - idx;
    const p1 = this._scanPath[Math.min(idx, this._scanPath.length - 1)];
    const p2 = this._scanPath[Math.min(idx + 1, this._scanPath.length - 1)];

    const x = p1.x + (p2.x - p1.x) * t;
    const y = p1.y + (p2.y - p1.y) * t;
    const z = p1.z + (p2.z - p1.z) * t;

    this._scanLight.position.set(x, y + 5, z);

    // 更新拖尾位置（延迟跟随）
    const trailStep = 0.005;
    this._scanTrail.forEach((trail, i) => {
      let trailProgress = this._scanProgress - (i + 1) * trailStep;
      if (trailProgress < 0) trailProgress += 1;
      const tIdx = trailProgress * totalLen;
      const tI = Math.floor(tIdx);
      const tT = tIdx - tI;
      const tp1 = this._scanPath[Math.min(tI, this._scanPath.length - 1)];
      const tp2 = this._scanPath[Math.min(tI + 1, this._scanPath.length - 1)];
      trail.position.set(
        tp1.x + (tp2.x - tp1.x) * tT,
        tp1.y + (tp2.y - tp1.y) * tT + 3,
        tp1.z + (tp2.z - tp1.z) * tT
      );
    });
  }

  /* ===== 全航道简化模式：航段流光扫描效果 ===== */

  /**
   * 为单个航段构建流光扫描效果（简化模式专用）
   * 简化模式下不渲染精确地形网格，而是用发光边界线 + 流动光点表示航段
   * 每个航段独立拥有自己的边界线和流光动画
   *
   * @param {number} segId - 航段 ID
   * @param {Array} northBoundary - 所属航道的北边界坐标
   * @param {Array} southBoundary - 所属航道的南边界坐标
   * @param {number} centerLat - 全局参考中心纬度
   * @param {number} centerLng - 全局参考中心经度
   * @param {string} sectionLabel - 航段所属区域标签（"南槽下段"/"南槽上段"/"南支航道"）
   * @private
   */
  _buildSegmentScanEffect(segId, northBoundary, southBoundary, centerLat, centerLng, sectionLabel) {
    const SEGMENTS = window.SEGMENTS || [];
    const _segDefs = window._segDefs || [];
    const seg = SEGMENTS[segId - 1];
    if (!seg) return;

    const sd = _segDefs.find(d => d.id === segId);
    if (!sd || !sd.northSlice || !sd.southSlice) return;

    // 获取该航段的边界点切片
    const nPts = northBoundary.slice(sd.northSlice[0], sd.northSlice[1]);
    const sPts = southBoundary.slice(sd.southSlice[0], sd.southSlice[1]);
    if (nPts.length < 2 || sPts.length < 2) return;

    // 转为局部坐标
    const nLocal = nPts.map(p => geoToLocal(p[0], p[1], centerLat, centerLng));
    const sLocal = sPts.map(p => geoToLocal(p[0], p[1], centerLat, centerLng));

    // 计算航段中心点
    const allLocal = [...nLocal, ...sLocal];
    const centerX = allLocal.reduce((s, p) => s + p.x, 0) / allLocal.length;
    const centerZ = allLocal.reduce((s, p) => s + p.z, 0) / allLocal.length;

    // 航段颜色（根据航道区域）
    const isBranch = sectionLabel === '南支航道';
    const northColor = isBranch ? 0xaa88ff : 0x00ff88;
    const southColor = isBranch ? 0xaa88ff : 0xff8800;
    const highlightColor = isBranch ? 0xcc99ff : 0x00d4ff;

    const bndLineY = WATER_LEVEL_Y + 5;

    // 创建航段边界线组
    const segGroup = new THREE.Group();
    segGroup.userData = { type: 'segmentBoundary', segId: segId };

    // 北边界
    const nVerts = [];
    nLocal.forEach(p => nVerts.push(p.x, bndLineY, p.z));
    const nGeo = new THREE.BufferGeometry();
    nGeo.setAttribute('position', new THREE.Float32BufferAttribute(nVerts, 3));
    const nMat = new THREE.LineBasicMaterial({
      color: northColor, linewidth: 3, transparent: true, opacity: 0.95
    });
    const nLine = new THREE.Line(nGeo, nMat);
    segGroup.add(nLine);

    // 南边界
    const sVerts = [];
    sLocal.forEach(p => sVerts.push(p.x, bndLineY, p.z));
    const sGeo = new THREE.BufferGeometry();
    sGeo.setAttribute('position', new THREE.Float32BufferAttribute(sVerts, 3));
    const sMat = new THREE.LineBasicMaterial({
      color: southColor, linewidth: 3, transparent: true, opacity: 0.95
    });
    const sLine = new THREE.Line(sGeo, sMat);
    segGroup.add(sLine);

    // 航段两端连接线
    const endVerts = [
      nLocal[0].x, bndLineY, nLocal[0].z,
      sLocal[0].x, bndLineY, sLocal[0].z,
      sLocal[sLocal.length - 1].x, bndLineY, sLocal[sLocal.length - 1].z,
      nLocal[nLocal.length - 1].x, bndLineY, nLocal[nLocal.length - 1].z,
      nLocal[0].x, bndLineY, nLocal[0].z
    ];
    const endGeo = new THREE.BufferGeometry();
    endGeo.setAttribute('position', new THREE.Float32BufferAttribute(endVerts, 3));
    const endMat = new THREE.LineBasicMaterial({
      color: highlightColor, linewidth: 2, transparent: true, opacity: 0.5
    });
    segGroup.add(new THREE.Line(endGeo, endMat));

    // 航段名称标签
    const labelSprite = this._createSegmentLabel(seg.name || `航段${segId}`, centerX, bndLineY + 30, centerZ, highlightColor);
    if (labelSprite) segGroup.add(labelSprite);

    this.boundaryGroup.add(segGroup);

    // 保存航段边界信息用于流光动画和点击检测
    this._segmentBoundaryMeshes.push({
      segId,
      group: segGroup,
      nLocal,
      sLocal,
      centerX,
      centerZ,
      highlightColor,
      isHighlighted: false
    });
  }

  /**
   * 创建航段名称标签
   * @private
   */
  _createSegmentLabel(name, x, y, z, color) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 256;
    canvas.height = 64;

    const colorStr = typeof color === 'number' ? '#' + color.toString(16).padStart(6, '0') : color;

    ctx.fillStyle = 'rgba(0, 20, 40, 0.7)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = colorStr;
    ctx.lineWidth = 2;
    ctx.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);

    ctx.shadowColor = colorStr;
    ctx.shadowBlur = 10;
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 24px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    const spriteMaterial = new THREE.SpriteMaterial({
      map: texture, transparent: true, depthWrite: false
    });
    const sprite = new THREE.Sprite(spriteMaterial);
    sprite.position.set(x, y, z);
    sprite.scale.set(120, 30, 1);
    return sprite;
  }

  /**
   * 初始化各航段独立流光扫描
   * @private
   */
  _initSegmentScans() {
    // 清除旧的扫光对象
    if (this._scanLight) {
      this.boundaryGroup.remove(this._scanLight);
      this._scanLight.geometry.dispose();
      this._scanLight.material.dispose();
      this._scanLight = null;
    }
    this._scanTrail.forEach(m => {
      this.boundaryGroup.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    });
    this._scanTrail = [];

    // 为每个航段创建独立的流光效果
    this._segmentScanEffects = this._segmentBoundaryMeshes.map(segInfo => {
      // 创建流光光点
      const lightGeo = new THREE.SphereGeometry(10, 16, 12);
      const lightMat = new THREE.MeshBasicMaterial({
        color: segInfo.highlightColor,
        transparent: true,
        opacity: 0.9
      });
      const light = new THREE.Mesh(lightGeo, lightMat);
      light.visible = false;
      this.boundaryGroup.add(light);

      // 创建拖尾
      const trails = [];
      const trailCount = 8;
      for (let i = 0; i < trailCount; i++) {
        const t = i / trailCount;
        const trailGeo = new THREE.SphereGeometry(7 * (1 - t * 0.5), 8, 6);
        const trailMat = new THREE.MeshBasicMaterial({
          color: segInfo.highlightColor,
          transparent: true,
          opacity: 0.5 * (1 - t)
        });
        const trailMesh = new THREE.Mesh(trailGeo, trailMat);
        trailMesh.visible = false;
        this.boundaryGroup.add(trailMesh);
        trails.push(trailMesh);
      }

      // 构建沿航段边界的路径点（北边界正向 + 南边界反向，形成闭环）
      const path = [];
      segInfo.nLocal.forEach(p => path.push({ x: p.x, y: WATER_LEVEL_Y + 5, z: p.z }));
      for (let i = segInfo.sLocal.length - 1; i >= 0; i--) {
        path.push({ x: segInfo.sLocal[i].x, y: WATER_LEVEL_Y + 5, z: segInfo.sLocal[i].z });
      }

      return {
        segId: segInfo.segId,
        light,
        trails,
        path,
        progress: Math.random(), // 随机起始位置，避免所有航段同步
        speed: 0.001 + Math.random() * 0.0015, // 随机速度
        isHighlighted: false,
        highlightIntensity: 0
      };
    });

    console.log(`[Channel3D] 航段流光扫描初始化完成: ${this._segmentScanEffects.length} 个航段`);
  }

  /**
   * 更新航段流光扫描动画
   * @private
   */
  _animateSegmentScans() {
    if (!this._segmentScanEffects || this._segmentScanEffects.length === 0) return;

    this._segmentScanEffects.forEach(effect => {
      effect.progress += effect.speed;
      if (effect.progress >= 1) effect.progress -= 1;

      const totalLen = effect.path.length - 1;
      if (totalLen < 1) return;

      const exactIdx = effect.progress * totalLen;
      const idx = Math.floor(exactIdx);
      const t = exactIdx - idx;
      const p1 = effect.path[Math.min(idx, effect.path.length - 1)];
      const p2 = effect.path[Math.min(idx + 1, effect.path.length - 1)];

      const x = p1.x + (p2.x - p1.x) * t;
      const y = p1.y + (p2.y - p1.y) * t;
      const z = p1.z + (p2.z - p1.z) * t;

      // 更新流光位置
      effect.light.visible = true;
      effect.light.position.set(x, y + 8, z);

      // 更新拖尾
      const trailStep = 0.008;
      effect.trails.forEach((trail, i) => {
        let trailProgress = effect.progress - (i + 1) * trailStep;
        if (trailProgress < 0) trailProgress += 1;
        const tIdx = trailProgress * totalLen;
        const tI = Math.floor(tIdx);
        const tT = tIdx - tI;
        const tp1 = effect.path[Math.min(tI, effect.path.length - 1)];
        const tp2 = effect.path[Math.min(tI + 1, effect.path.length - 1)];
        trail.visible = true;
        trail.position.set(
          tp1.x + (tp2.x - tp1.x) * tT,
          tp1.y + (tp2.y - tp1.y) * tT + 5,
          tp1.z + (tp2.z - tp1.z) * tT
        );
      });

      // 高亮效果：流光经过时航段边界线变亮
      const segInfo = this._segmentBoundaryMeshes.find(s => s.segId === effect.segId);
      if (segInfo && segInfo.group) {
        // 当流光在航段上时，增加高亮强度
        const isActive = effect.progress < 0.3 || effect.progress > 0.7;
        segInfo.isHighlighted = isActive;

        segInfo.group.children.forEach(child => {
          if (child.material) {
            child.material.opacity = isActive ? 1.0 : 0.6;
          }
        });
      }
    });
  }

  /**
   * 处理简化模式下的航段点击
   * @private
   */
  _handleSegmentClick(event) {
    if (!this._isSimplifiedMode || !this._onSegmentClick) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);

    // 检测与航段边界线的交点
    for (const segInfo of this._segmentBoundaryMeshes) {
      if (!segInfo.group) continue;
      const intersects = this.raycaster.intersectObjects(segInfo.group.children, true);
      if (intersects.length > 0) {
        console.log(`[Channel3D] 点击航段: ${segInfo.segId}`);
        this._onSegmentClick(segInfo.segId);
        return;
      }
    }
  }

  /* ===== 航段立体3D模型 ===== */

  /**
   * 构建航段立体3D模型（360度可旋转视图）
   * 从全航道视图切换到单个航段的详细三维视图
   *
   * 构建流程:
   *   1. 清除所有旧场景对象
   *   2. 设置剖视图模式标志
   *   3. 根据 segId 确定对应的航段数据（下段1~6/上段7~11/南支12~14）
   *   4. 构建地形、水面、边界线
   *   5. 构建航段深度横截面视图
   *   6. 构建船舶模型（含搁浅检测）
   *   7. 设置相机视角
   *
   * @param {number|string} segId - 航段 ID (1~14)
   * @param {object} channelDataMap - 全航道数据映射 { lower, upper, branch }
   * @param {Array} shipsWithDraft - 船舶数据（含吃水深度）
   */
  buildSegmentCrossSection(segId, channelDataMap, shipsWithDraft) {
    if (!channelDataMap) return;

    // 清除场景中的主要对象
    this._clearGroup(this.terrainGroup);
    this._clearGroup(this.waterGroup);
    this._clearGroup(this.shipGroup);
    this._clearGroup(this.boundaryGroup);
    this._clearGroup(this._crossSectionGroup);

    // 清除扫光
    if (this._scanLight) {
      this.boundaryGroup.remove(this._scanLight);
      this._scanLight.geometry.dispose();
      this._scanLight.material.dispose();
      this._scanLight = null;
    }
    this._scanTrail.forEach(m => {
      this.boundaryGroup.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    });
    this._scanTrail = [];
    this._scanPath = [];

    this._isCrossSection = true;
    this._isFullChannel = false;
    // 如果当前处于船舶运动态势模式，先退出
    if (this._isShipMotion) {
      this.exitShipMotion();
    }

    // 获取航段边界数据（从全局变量，ES module中通过window访问）
    const SEGMENTS = window.SEGMENTS || [];
    const _segDefs = window._segDefs || [];
    const SHIPS = window.SHIPS || [];
    const seg = SEGMENTS[segId - 1] || null;
    if (!seg || seg.type === 'warning') return;

    // 根据segId确定使用哪段航道数据
    let channelData;
    if (segId >= 1 && segId <= 6) channelData = channelDataMap.lower;
    else if (segId >= 7 && segId <= 11) channelData = channelDataMap.upper;
    else if (segId >= 12 && segId <= 14) channelData = channelDataMap.branch;
    if (!channelData) return;

    const northBoundary = channelData.north_boundary;
    const southBoundary = channelData.south_boundary;
    if (!northBoundary || !southBoundary) return;

    // 使用外部函数获取航段切片
    const nArr = northBoundary;
    const sArr = southBoundary;
    const sd = _segDefs.find(d => d.id === segId) || null;
    if (!sd) return;

    const nPts = nArr.slice(sd.northSlice[0], sd.northSlice[1]);
    const sPts = sArr.slice(sd.southSlice[0], sd.southSlice[1]);
    if (nPts.length < 2 || sPts.length < 2) return;

    // 计算中心点和参考坐标
    const allLats = [...nPts, ...sPts].map(p => p[0]);
    const allLngs = [...nPts, ...sPts].map(p => p[1]);
    const centerLat = (Math.min(...allLats) + Math.max(...allLats)) / 2;
    const centerLng = (Math.min(...allLngs) + Math.max(...allLngs)) / 2;
    this._refLat = centerLat;
    this._refLng = centerLng;

    // 转为局部坐标
    const nLocal = nPts.map(p => geoToLocal(p[0], p[1], centerLat, centerLng));
    const sLocal = sPts.map(p => geoToLocal(p[0], p[1], centerLat, centerLng));

    // 计算航段局部范围
    const allLocal = [...nLocal, ...sLocal];
    const localMinX = Math.min(...allLocal.map(p => p.x));
    const localMaxX = Math.max(...allLocal.map(p => p.x));
    const localMinZ = Math.min(...allLocal.map(p => p.z));
    const localMaxZ = Math.max(...allLocal.map(p => p.z));

    const padFactor = 0.3;
    const rangeX = localMaxX - localMinX;
    const rangeZ = localMaxZ - localMinZ;
    const gridMinX = localMinX - rangeX * padFactor;
    const gridMaxX = localMaxX + rangeX * padFactor;
    const gridMinZ = localMinZ - rangeZ * padFactor;
    const gridMaxZ = localMaxZ + rangeZ * padFactor;

    // 估算航道宽度
    let channelWidth = 0;
    const sampleCount = Math.min(nLocal.length, sLocal.length);
    for (let i = 0; i < sampleCount; i++) {
      channelWidth += Math.hypot(nLocal[i].x - sLocal[i].x, nLocal[i].z - sLocal[i].z);
    }
    channelWidth /= sampleCount;
    const halfWidth = channelWidth / 2;

    const rng = seededRandom(42 + segId);

    // 使用较高分辨率网格构建立体地形
    const gridSize = TERRAIN_GRID;
    const stepX = (gridMaxX - gridMinX) / (gridSize - 1);
    const stepZ = (gridMaxZ - gridMinZ) / (gridSize - 1);

    // 生成深度网格数据
    const depths = [];
    for (let row = 0; row < gridSize; row++) {
      const rowDepths = [];
      for (let col = 0; col < gridSize; col++) {
        const px = gridMinX + col * stepX;
        const pz = gridMinZ + row * stepZ;

        let minDistToNorth = Infinity;
        let minDistToSouth = Infinity;

        for (let i = 0; i < nLocal.length - 1; i++) {
          const d = pointToSegmentDist(px, pz, nLocal[i].x, nLocal[i].z, nLocal[i + 1].x, nLocal[i + 1].z);
          if (d < minDistToNorth) minDistToNorth = d;
        }
        for (let i = 0; i < sLocal.length - 1; i++) {
          const d = pointToSegmentDist(px, pz, sLocal[i].x, sLocal[i].z, sLocal[i + 1].x, sLocal[i + 1].z);
          if (d < minDistToSouth) minDistToSouth = d;
        }

        const minDistToBoundary = Math.min(minDistToNorth, minDistToSouth);
        const distFromCenter = Math.abs(minDistToNorth - minDistToSouth);
        const normalizedDist = distFromCenter / halfWidth;

        let depth;
        if (normalizedDist < 0.4) {
          depth = CHANNEL_CENTER_DEPTH.min + rng() * (CHANNEL_CENTER_DEPTH.max - CHANNEL_CENTER_DEPTH.min);
        } else if (normalizedDist < 0.8) {
          const t = (normalizedDist - 0.4) / 0.4;
          const centerD = lerp(CHANNEL_CENTER_DEPTH.min, CHANNEL_CENTER_DEPTH.max, rng());
          const edgeD = lerp(CHANNEL_EDGE_DEPTH.min, CHANNEL_EDGE_DEPTH.max, rng());
          depth = lerp(centerD, edgeD, t);
        } else if (minDistToBoundary < halfWidth * 1.8) {
          const t = Math.min((minDistToBoundary - halfWidth) / (halfWidth * 0.8), 1);
          const edgeD = lerp(CHANNEL_EDGE_DEPTH.min, CHANNEL_EDGE_DEPTH.max, rng());
          depth = lerp(edgeD, OUTSIDE_DEPTH, Math.max(0, t));
        } else {
          depth = OUTSIDE_DEPTH;
        }

        rowDepths.push(depth);
      }
      depths.push(rowDepths);
    }

    // 缓存深度数据供船舶吃水检测使用
    this._depthGridData = new Float32Array(gridSize * gridSize);
    for (let row = 0; row < gridSize; row++) {
      for (let col = 0; col < gridSize; col++) {
        this._depthGridData[row * gridSize + col] = depths[row][col];
      }
    }

    // 创建地形网格（使用PlaneGeometry，顶点按深度偏移）
    const tWidth = gridMaxX - gridMinX;
    const tHeight = gridMaxZ - gridMinZ;
    const geometry = new THREE.PlaneGeometry(tWidth, tHeight, gridSize - 1, gridSize - 1);
    geometry.rotateX(-Math.PI / 2);

    const positions = geometry.attributes.position;
    const colors = new Float32Array(positions.count * 3);

    for (let row = 0; row < gridSize; row++) {
      for (let col = 0; col < gridSize; col++) {
        const vi = row * gridSize + col;
        const depth = depths[row][col];
        const terrainY = depth * DEPTH_EXAGGERATION;
        positions.setY(vi, terrainY);

        const color = depthToColor(depth);
        colors[vi * 3] = color.r;
        colors[vi * 3 + 1] = color.g;
        colors[vi * 3 + 2] = color.b;
      }
    }

    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    positions.needsUpdate = true;

    const material = new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.DoubleSide
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    mesh.position.set((gridMinX + gridMaxX) / 2, 0, (gridMinZ + gridMaxZ) / 2);
    this._crossSectionGroup.add(mesh);

    // 保存深度网格元数据
    const meta = {
      gridMinX, gridMaxX, gridMinZ, gridMaxZ,
      stepX, stepZ,
      gridWidth: gridSize, gridHeight: gridSize,
      centerLat, centerLng, halfWidth
    };
    this._depthGridMeta = meta;

    // ========== 水面标识（5层，覆盖整个立体航段区域） ==========
    const waterLevel = WATER_LEVEL_Y;
    const waterRangeX = gridMaxX - gridMinX;
    const waterRangeZ = gridMaxZ - gridMinZ;

    // 1. 水面背景平面（半透明浅蓝色）
    const waterGeo = new THREE.PlaneGeometry(waterRangeX * 1.05, waterRangeZ * 1.05, TERRAIN_GRID, TERRAIN_GRID);
    waterGeo.rotateX(-Math.PI / 2);
    const waterMat = new THREE.MeshBasicMaterial({
      color: 0x1a5588, transparent: true, opacity: 0.25,
      side: THREE.DoubleSide, depthWrite: false
    });
    const waterMesh = new THREE.Mesh(waterGeo, waterMat);
    waterMesh.position.set((gridMinX + gridMaxX) / 2, waterLevel, (gridMinZ + gridMaxZ) / 2);
    this._crossSectionGroup.add(waterMesh);

    // 2. 水面实体线（沿航道边界的水面线）
    const waterLineVerts = [];
    // 北边界水面线
    for (let i = 0; i < nLocal.length; i++) {
      waterLineVerts.push(nLocal[i].x, waterLevel, nLocal[i].z);
    }
    // 南边界水面线
    for (let i = 0; i < sLocal.length; i++) {
      waterLineVerts.push(sLocal[i].x, waterLevel, sLocal[i].z);
    }
    const waterLineGeo = new THREE.BufferGeometry();
    waterLineGeo.setAttribute('position', new THREE.Float32BufferAttribute(waterLineVerts, 3));
    const waterLineMat = new THREE.LineBasicMaterial({ color: SCAN_LIGHT_COLOR, linewidth: 2 });
    const waterLine = new THREE.Line(waterLineGeo, waterLineMat);
    this._crossSectionGroup.add(waterLine);

    // 3. 水面发光条（沿航道中心线）
    const centerLineVerts = [];
    for (let i = 0; i < sampleCount; i++) {
      const cx = (nLocal[i].x + sLocal[i].x) / 2;
      const cz = (nLocal[i].z + sLocal[i].z) / 2;
      centerLineVerts.push(cx, waterLevel, cz);
    }
    const glowGeo = new THREE.BufferGeometry();
    glowGeo.setAttribute('position', new THREE.Float32BufferAttribute(centerLineVerts, 3));
    const glowMat = new THREE.LineBasicMaterial({
      color: SCAN_LIGHT_COLOR, transparent: true, opacity: 0.6, linewidth: 3
    });
    const glowLine = new THREE.Line(glowGeo, glowMat);
    this._crossSectionGroup.add(glowLine);

    // 4. 水面标签
    this._addCrossSectionLabel('水面线 (Y=0)', gridMinX + waterRangeX * 0.05, waterLevel + 25, gridMinZ + 20, SCAN_LIGHT_COLOR, 18);

    // 5. 水面箭头指示（指向水面）
    const arrowShape = new THREE.Shape();
    arrowShape.moveTo(0, 0);
    arrowShape.lineTo(-8, 15);
    arrowShape.lineTo(8, 15);
    arrowShape.closePath();
    const arrowGeo = new THREE.ShapeGeometry(arrowShape);
    const arrowMat = new THREE.MeshBasicMaterial({ color: SCAN_LIGHT_COLOR, transparent: true, opacity: 0.7, side: THREE.DoubleSide });
    const arrowMesh = new THREE.Mesh(arrowGeo, arrowMat);
    arrowMesh.position.set(gridMinX + waterRangeX * 0.05, waterLevel - 30, gridMinZ + 20);
    this._crossSectionGroup.add(arrowMesh);

    // ========== 航道边界线 ==========
    const bndLineY = waterLevel + 3;
    [
      { pts: nLocal, color: 0x00ff88, label: '北界' },
      { pts: sLocal, color: 0xff8800, label: '南界' }
    ].forEach(({ pts, color }) => {
      if (!pts || pts.length < 2) return;
      const verts = [];
      pts.forEach(p => verts.push(p.x, bndLineY, p.z));
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      const mat = new THREE.LineBasicMaterial({ color, linewidth: 2, transparent: true, opacity: 0.9 });
      this._crossSectionGroup.add(new THREE.Line(geo, mat));
    });

    // ========== 船舶模型（使用 _buildShipModels，按真实比例和位置） ==========
    const SHIPS_DATA = shipsWithDraft || SHIPS;
    const segShips = SHIPS_DATA ? SHIPS_DATA.filter(s => s.segment === segId) : [];

    // 设置当前航段信息（_buildShipModels 需要）
    this.currentSegment = {
      channelData: { north_boundary: nPts, south_boundary: sPts },
      segId,
      meta
    };

    if (segShips.length > 0) {
      // 临时将船舶数据转换为 _buildShipModels 需要的格式
      // 船舶位置使用真实经纬度，_buildShipModels 会自动转为局部坐标
      this._buildShipModels(segShips);
    }

    // 深度刻度标注（左侧，沿Z方向排列）
    const maxH = Math.abs(CHANNEL_CENTER_DEPTH.min) * DEPTH_EXAGGERATION;
    for (let d = 2; d <= 12; d += 2) {
      const y = -d * DEPTH_EXAGGERATION;
      if (Math.abs(y) > maxH) break;
      this._addCrossSectionLabel(
        `-${d}m`,
        gridMinX - waterRangeX * 0.08, y, gridMinZ + waterRangeZ * 0.1,
        0x6a8aa8, 14
      );
    }

    // 添加剖视图组到场景
    this.scene.add(this._crossSectionGroup);

    // 设置相机（默认侧面视角，但允许自由旋转）
    this._setupCrossSectionCamera(waterRangeX, waterRangeZ, maxH, waterLevel, gridMinX, gridMaxX, gridMinZ, gridMaxZ);

    // 保存当前航段信息
    this.currentSegId = segId;

    console.log(`[Channel3D] 航段 ${segId} 立体3D模型构建完成, 范围: ${waterRangeX.toFixed(0)}x${waterRangeZ.toFixed(0)}m`);
  }

  /**
   * 设置剖视图相机（默认侧面视角，允许360度自由旋转）
   * @private
   */
  _setupCrossSectionCamera(rangeX, rangeZ, maxHeight, waterLevel, gridMinX, gridMaxX, gridMinZ, gridMaxZ) {
    if (!this.camera || !this.controls) return;

    // 销毁并重建控制器
    if (this.controls) {
      this.controls.dispose();
    }
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    // 移除 maxPolarAngle 限制，允许相机看到水下
    this.controls.minDistance = 50;
    this.controls.maxDistance = 5000;

    // 计算场景中心
    const centerX = (gridMinX + gridMaxX) / 2;
    const centerZ = (gridMinZ + gridMaxZ) / 2;
    const maxRange = Math.max(rangeX, rangeZ);

    // 默认视角：斜上方45度俯视+侧面，能同时看到航道长度和深度
    const viewHeight = Math.abs(maxHeight) * 0.8;
    const viewDist = Math.max(maxRange * 0.7, 400);

    // target 在场景中心偏下（让水下地形也在视野中）
    this.controls.target.set(centerX, waterLevel - viewHeight * 0.3, centerZ);
    // 相机位置：斜上方，有X偏移（侧面角度）+ Y偏移（俯视角度）+ Z偏移（距离）
    this.camera.position.set(
      centerX + viewDist * 0.4,   // 侧面偏移
      waterLevel + viewHeight * 0.8, // 俯视高度
      centerZ + viewDist * 0.7    // 前方距离
    );
    this.camera.lookAt(centerX, waterLevel - viewHeight * 0.3, centerZ);
    this.controls.update();

    this.camera.updateProjectionMatrix();
  }

  _addCrossSectionLabel(text, x, y, z, color, fontSize = 14) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const fs = fontSize;
    const padding = 8;
    // 测量文字宽度
    ctx.font = `bold ${fs}px sans-serif`;
    const metrics = ctx.measureText(text);
    const textWidth = metrics.width;
    canvas.width = Math.ceil(textWidth + padding * 2);
    canvas.height = Math.ceil(fs + padding * 2);

    // 背景
    ctx.fillStyle = 'rgba(0, 20, 40, 0.75)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 文字
    const colorStr = typeof color === 'number' ? '#' + color.toString(16).padStart(6, '0') : color;
    ctx.shadowColor = colorStr;
    ctx.shadowBlur = 6;
    ctx.fillStyle = colorStr;
    ctx.font = `bold ${fs}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    const spriteMaterial = new THREE.SpriteMaterial({
      map: texture, transparent: true, depthWrite: false
    });
    const sprite = new THREE.Sprite(spriteMaterial);
    sprite.position.set(x, y, z);
    // 根据字体大小调整sprite缩放
    const scaleX = canvas.width * 0.35;
    const scaleY = canvas.height * 0.35;
    sprite.scale.set(scaleX, scaleY, 1);
    this._crossSectionGroup.add(sprite);
  }

  _buildWarningZone(coords, centerLat, centerLng, color, name) {
    if (!coords || coords.length < 3) return;
    const localPts = coords.map(p => geoToLocal(p[0], p[1], centerLat, centerLng));

    // 创建多边形形状
    const shape = new THREE.Shape();
    shape.moveTo(localPts[0].x, localPts[0].z);
    for (let i = 1; i < localPts.length; i++) {
      shape.lineTo(localPts[i].x, localPts[i].z);
    }
    shape.closePath();

    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);

    const mat = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.15,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = WATER_LEVEL_Y + 1; // 略高于水面
    this.boundaryGroup.add(mesh);

    // 警戒区边界线
    const lineVerts = [];
    localPts.forEach(p => lineVerts.push(p.x, WATER_LEVEL_Y + 2, p.z));
    lineVerts.push(localPts[0].x, WATER_LEVEL_Y + 2, localPts[0].z); // 闭合
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(lineVerts, 3));
    const lineMat = new THREE.LineBasicMaterial({ color, linewidth: 2, transparent: true, opacity: 0.8 });
    this.boundaryGroup.add(new THREE.Line(lineGeo, lineMat));

    // 警戒区标签
    const cx = localPts.reduce((s, p) => s + p.x, 0) / localPts.length;
    const cz = localPts.reduce((s, p) => s + p.z, 0) / localPts.length;
    this._addShipLabel(name, cx, WATER_LEVEL_Y + 50, cz, true);
  }

  /**
   * 构建航段分界线
   * @private
   */
  _buildSegmentDividers(channelDataMap, centerLat, centerLng) {
    const sections = [
      { data: channelDataMap.lower, color: 0x00d4ff },
      { data: channelDataMap.upper, color: 0x00d4ff },
      { data: channelDataMap.branch, color: 0xaa88ff }
    ];

    sections.forEach(sec => {
      if (!sec || !sec.data) return;
      const nb = sec.data.north_boundary;
      const sb = sec.data.south_boundary;
      if (!nb || !sb || nb.length < 2 || sb.length < 2) return;

      // 在航道两端画分界线
      [0, nb.length - 1].forEach(idx => {
        const nPt = geoToLocal(nb[idx][0], nb[idx][1], centerLat, centerLng);
        const sPt = geoToLocal(sb[idx][0], sb[idx][1], centerLat, centerLng);

        const lineVerts = [nPt.x, WATER_LEVEL_Y + 3, nPt.z, sPt.x, WATER_LEVEL_Y + 3, sPt.z];
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(lineVerts, 3));
        const mat = new THREE.LineBasicMaterial({ color: sec.color, transparent: true, opacity: 0.4 });
        this.boundaryGroup.add(new THREE.Line(geo, mat));
      });
    });
  }

  /* ===== 船舶运动态势模式（极简版） ===== */

  /**
   * 构建船舶运动态势3D视图（极简版）
   * 船舶居中原点，BoxGeometry船体，PlaneGeometry水底，ArrowHelper风流，DOM信息面板
   * @param {object} options - { ship, hydrology, drafts, lateralOffset, onChange, segId }
   */
  buildShipMotionSituation(options) {
    if (!options || !options.ship) {
      console.warn('[Channel3D] buildShipMotionSituation: 缺少船舶数据');
      return;
    }
    const ship = options.ship;
    const hydrology = options.hydrology || {
      depth: 10, currentSpeed: 2.5, currentDir: 180,
      windSpeed: 6, windDir: 45
    };
    const shipDraft = ship.draft || (ship.length > 100 ? 6 : 4);
    const drafts = options.drafts || {
      fl: shipDraft, fc: shipDraft, fr: shipDraft,
      al: shipDraft, ac: shipDraft, ar: shipDraft
    };
    const lateralOffset = options.lateralOffset || 0;

    // 保存数据
    this._shipMotionData = ship;
    this._shipMotionHydrology = hydrology;
    this._shipMotionDrafts = drafts;
    this._shipMotionLateralOffset = lateralOffset;
    this._onShipMotionChange = options.onChange || null;

    // 退出其他模式
    if (this._isCrossSection) this.exitCrossSection();

    // 清除旧场景
    this._clearGroup(this.terrainGroup);
    this._clearGroup(this.waterGroup);
    this._clearGroup(this.shipGroup);
    this._clearGroup(this.boundaryGroup);
    this._clearGroup(this._shipMotionGroup);
    if (this._shipMotionPanelEl) {
      if (this._shipMotionPanelEl.parentNode) this._shipMotionPanelEl.parentNode.removeChild(this._shipMotionPanelEl);
      this._shipMotionPanelEl = null;
    }
    const leftPanel = document.getElementById('ship-motion-attitude-panel');
    if (leftPanel && leftPanel.parentNode) leftPanel.parentNode.removeChild(leftPanel);

    // 设置模式标志
    this._isShipMotion = true;
    this._isFullChannel = false;

    // 构建场景（船舶在原点）
    this._buildSimpleSeabed(hydrology.depth);
    this._buildSimpleShip(ship, drafts);
    this._buildSimpleArrows(hydrology);
    // 航道边界（笔直竖直平面）
    this._buildChannelBounds();
    this.scene.add(this._shipMotionGroup);

    // 相机
    this._setupShipMotionCamera();

    // 禁用后处理
    if (this._composer) {
      this._composerBackup = { enabled: true };
      this.composerEnabled = false;
    }

    // 信息面板
    this._buildShipMotionUI(ship, hydrology, drafts, lateralOffset);

    this.currentSegId = options.segId;
    console.log(`[Channel3D] 船舶运动态势视图构建完成: ${ship.name || '未知船舶'}`);
  }

  /**
   * 极简水底 — PlaneGeometry + vertexColors，船舶居中原点
   * @param {number} baseDepth - 水深(正值, 如10)
   * @private
   */
  _buildSimpleSeabed(baseDepth) {
    const size = 150;
    const grid = 16;
    const geo = new THREE.PlaneGeometry(size, size, grid - 1, grid - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const rng = seededRandom(42);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const dist = Math.hypot(x, z) / (size / 2);
      const noise = (rng() - 0.5) * 2;
      const depth = -(baseDepth * (1 - dist * 0.5) + noise);
      pos.setY(i, depth); // 船舶运动态势用1:1真实比例，不用深度夸张
      // 颜色：深蓝到浅蓝
      const t = Math.min(1, Math.abs(depth) / baseDepth);
      colors[i * 3] = 0.1 + (1 - t) * 0.3;
      colors[i * 3 + 1] = 0.2 + (1 - t) * 0.2;
      colors[i * 3 + 2] = 0.4 + (1 - t) * 0.3;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    this._shipMotionGroup.add(new THREE.Mesh(geo, mat));

    // 水面参考平面 (Y=0)
    const waterGeo = new THREE.PlaneGeometry(size * 1.1, size * 1.1);
    waterGeo.rotateX(-Math.PI / 2);
    const waterMat = new THREE.MeshBasicMaterial({
      color: 0x005588,
      transparent: true,
      opacity: 0.15,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    const waterMesh = new THREE.Mesh(waterGeo, waterMat);
    waterMesh.position.y = 0.1; // 略高于 Y=0 避免 z-fighting
    this._shipMotionGroup.add(waterMesh);

    // 水面边框线
    const waterEdgeGeo = new THREE.EdgesGeometry(new THREE.PlaneGeometry(size * 1.1, size * 1.1));
    const waterEdgeMat = new THREE.LineBasicMaterial({ color: 0x00aaff, transparent: true, opacity: 0.3 });
    const waterEdge = new THREE.LineSegments(waterEdgeGeo, waterEdgeMat);
    waterEdge.rotation.x = -Math.PI / 2;
    waterEdge.position.y = 0.1;
    this._shipMotionGroup.add(waterEdge);
  }

  /**
   * 极简船体 — BoxGeometry 水下+水上+驾驶室+船首，船舶在原点
   * @param {object} ship - 船舶数据
   * @param {object} drafts - 六点吃水
   * @private
   */
  _buildSimpleShip(ship, drafts) {
    const L = ship.length || 80;
    const W = ship.width || 15;
    const D = ship.draft || (L > 100 ? 6 : 4);
    const freeboard = Math.max(L * 0.06, 2);
    const heading = -(ship.heading || 0) * Math.PI / 180;

    // 计算姿态
    const attitude = this._calculateAttitude(drafts);

    // 内层：船舶本体（含横倾/纵倾）
    const innerGroup = new THREE.Group();

    // 水下船体
    const hullGeo = new THREE.BoxGeometry(L, D, W);
    const hullMat = new THREE.MeshBasicMaterial({ color: 0x2266aa, transparent: true, opacity: 0.8 });
    const hull = new THREE.Mesh(hullGeo, hullMat);
    hull.position.y = -D / 2;
    innerGroup.add(hull);

    // 水上船体
    const aboveGeo = new THREE.BoxGeometry(L * 0.95, freeboard, W * 0.9);
    const aboveMat = new THREE.MeshBasicMaterial({ color: 0x4488aa });
    const above = new THREE.Mesh(aboveGeo, aboveMat);
    above.position.y = freeboard / 2;
    innerGroup.add(above);

    // 驾驶室
    const bridgeGeo = new THREE.BoxGeometry(L * 0.1, freeboard * 1.5, W * 0.4);
    const bridgeMat = new THREE.MeshBasicMaterial({ color: 0xccddee });
    const bridge = new THREE.Mesh(bridgeGeo, bridgeMat);
    bridge.position.set(L * 0.25, freeboard + freeboard * 0.75, 0);
    innerGroup.add(bridge);

    // 船首（小锚体）
    const bowGeo = new THREE.ConeGeometry(W * 0.2, L * 0.12, 4);
    bowGeo.rotateZ(-Math.PI / 2);
    const bowMat = new THREE.MeshBasicMaterial({ color: 0x4488aa });
    const bow = new THREE.Mesh(bowGeo, bowMat);
    bow.position.set(L * 0.5 + L * 0.06, 0, 0);
    innerGroup.add(bow);

    // 应用姿态
    innerGroup.rotation.x = attitude.trimAngle;
    innerGroup.rotation.z = attitude.heelAngle;

    // 外层：航向
    const outerGroup = new THREE.Group();
    outerGroup.rotation.y = heading;
    outerGroup.add(innerGroup);

    this._shipMotionGroup.add(outerGroup);
    this._shipMotionShipGroup = { outerGroup, innerGroup };
  }

  /**
   * 风/流方向 — 各一个 ArrowHelper
   * @param {object} hydrology - 水文数据
   * @private
   */
  _buildSimpleArrows(hydrology) {
    // 水流箭头
    const cDir = -hydrology.currentDir * Math.PI / 180;
    const cLen = 15 + hydrology.currentSpeed * 5;
    const currentArrow = new THREE.ArrowHelper(
      new THREE.Vector3(Math.sin(cDir), 0, Math.cos(cDir)).normalize(),
      new THREE.Vector3(-40, WATER_Y + 1, 0),
      cLen, 0x00ccff, cLen * 0.2, cLen * 0.1
    );
    this._shipMotionGroup.add(currentArrow);

    // 风箭头
    const wDir = -hydrology.windDir * Math.PI / 180;
    const wLen = 10 + hydrology.windSpeed * 2;
    const windArrow = new THREE.ArrowHelper(
      new THREE.Vector3(Math.sin(wDir), 0, Math.cos(wDir)).normalize(),
      new THREE.Vector3(40, WATER_Y + 20, 0),
      wLen, 0xffffff, wLen * 0.2, wLen * 0.1
    );
    this._shipMotionGroup.add(windArrow);
  }

  /**
   * 极简相机 — 看向船舶中心偏下
   * @private
   */
  _setupShipMotionCamera() {
    if (!this.camera || !this.controls) return;
    this.controls.dispose();
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 30;
    this.controls.maxDistance = 400;
    this.controls.target.set(0, -2, 0); // 看向水面略下方
    this.camera.position.set(60, 30, 80); // 降低相机高度
    this.camera.lookAt(0, -2, 0);
    this.controls.update();
  }

  /**
   * 根据六点吃水计算横倾角和纵倾角
   * @param {object} drafts - { fl, fc, fr, al, ac, ar }
   * @returns {{ heelAngle: number, trimAngle: number }}
   * @private
   */
  _calculateAttitude(drafts) {
    if (!drafts) return { heelAngle: 0, trimAngle: 0 };
    const fl = drafts.fl || 0, fc = drafts.fc || 0, fr = drafts.fr || 0;
    const al = drafts.al || 0, ac = drafts.ac || 0, ar = drafts.ar || 0;
    const ship = this._shipMotionData || {};
    const width = ship.width || 15;
    const length = ship.length || 80;
    // 返回弧度值（直接用于 Three.js rotation）
    const heelAngle = Math.atan2((fl + al) / 2 - (fr + ar) / 2, width);
    const trimAngle = Math.atan2((fl + fc + fr) / 3 - (al + ac + ar) / 3, length);
    return { heelAngle, trimAngle };
  }

  /**
   * 构建船舶运动态势UI信息面板（DOM overlay）
   * @param {object} ship - 船舶数据
   * @param {object} hydrology - 水文数据
   * @param {object} drafts - 六点吃水
   * @param {number} lateralOffset - 横移偏移
   * @private
   */
  _buildShipMotionUI(ship, hydrology, drafts, lateralOffset) {
    const oldPanel = document.getElementById('ship-motion-panel');
    if (oldPanel) oldPanel.remove();
    const oldLeftPanel = document.getElementById('ship-motion-attitude-panel');
    if (oldLeftPanel) oldLeftPanel.remove();

    const attitude = this._calculateAttitude(drafts);
    const heelDeg = (attitude.heelAngle * 180 / Math.PI).toFixed(2);
    const trimDeg = (attitude.trimAngle * 180 / Math.PI).toFixed(2);
    const maxDraft = Math.max(drafts.fl || 0, drafts.fc || 0, drafts.fr || 0, drafts.al || 0, drafts.ac || 0, drafts.ar || 0);
    const ukc = hydrology.depth - maxDraft;
    const ukcColor = ukc > 1 ? '#44ff44' : ukc > 0 ? '#ffaa00' : '#ff4444';

    // ===== 左侧姿态面板 =====
    const heelVisual = (parseFloat(heelDeg) * 10).toFixed(1);
    const trimVisual = (parseFloat(trimDeg) * 10).toFixed(1);
    const absHeelVal = Math.abs(parseFloat(heelDeg));
    const absTrimVal = Math.abs(parseFloat(trimDeg));
    let attitudeStatus = '正常';
    let attitudeStatusColor = '#44ff44';
    if (absHeelVal >= 5 || absTrimVal >= 3) {
      attitudeStatus = '警告';
      attitudeStatusColor = '#ff4444';
    } else if (absHeelVal >= 3 || absTrimVal >= 2) {
      attitudeStatus = '注意';
      attitudeStatusColor = '#ffaa00';
    }

    const leftPanel = document.createElement('div');
    leftPanel.id = 'ship-motion-attitude-panel';
    leftPanel.style.cssText = `position:absolute;top:10px;left:10px;z-index:1002;width:220px;background:rgba(8,18,38,0.88);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid rgba(0,212,255,0.3);border-radius:12px;padding:14px;color:#c0d8f0;font-size:12px;line-height:1.6;font-family:'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;box-shadow:0 4px 24px rgba(0,0,0,0.4),0 0 16px rgba(0,180,255,0.1);`;
    leftPanel.innerHTML = `
      <div style="color:#00d4ff;font-size:13px;font-weight:600;margin-bottom:10px;border-bottom:1px solid rgba(0,212,255,0.2);padding-bottom:6px;">船舶姿态监测</div>

      <!-- 横倾 -->
      <div style="margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <span style="color:#8ab4d8;font-size:11px;">横倾角 (Heel)</span>
          <span id="sm-heel-left" style="color:#ffaa00;font-size:15px;font-weight:700;font-family:Consolas,monospace;">${heelDeg}°</span>
        </div>
        <div style="background:rgba(0,20,40,0.6);border-radius:6px;padding:4px;text-align:center;">
          <svg id="attitude-cross-section" width="180" height="100" viewBox="-90 -50 180 100">
            <line x1="-90" y1="0" x2="90" y2="0" stroke="#00aaff" stroke-width="1" stroke-dasharray="4,3"/>
            <text x="85" y="-5" fill="#00aaff" font-size="9">水线</text>
            <g class="ship-rect-g" transform="rotate(${heelVisual}, 0, 0)">
              <rect x="-15" y="-8" width="30" height="16" fill="rgba(34,102,170,0.6)" stroke="#4488aa" stroke-width="1" rx="2"/>
              <clipPath id="underwater-h"><rect x="-90" y="0" width="180" height="50"/></clipPath>
              <rect x="-15" y="-8" width="30" height="16" fill="rgba(0,100,180,0.3)" clip-path="url(#underwater-h)"/>
            </g>
            <text x="-60" y="30" fill="#ffaa00" font-size="10">${heelDeg}°</text>
            <text x="-60" y="42" fill="#6a8aa8" font-size="8">左倾为正</text>
          </svg>
        </div>
      </div>

      <!-- 纵倾 -->
      <div style="margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <span style="color:#8ab4d8;font-size:11px;">纵倾角 (Trim)</span>
          <span id="sm-trim-left" style="color:#ffaa00;font-size:15px;font-weight:700;font-family:Consolas,monospace;">${trimDeg}°</span>
        </div>
        <div style="background:rgba(0,20,40,0.6);border-radius:6px;padding:4px;text-align:center;">
          <svg id="attitude-long-section" width="180" height="60" viewBox="-90 -30 180 60">
            <line x1="-90" y1="0" x2="90" y2="0" stroke="#00aaff" stroke-width="1" stroke-dasharray="4,3"/>
            <text x="85" y="-5" fill="#00aaff" font-size="9">水线</text>
            <g class="ship-rect-g" transform="rotate(${trimVisual}, 0, 0)">
              <rect x="-60" y="-5" width="120" height="10" fill="rgba(34,102,170,0.6)" stroke="#4488aa" stroke-width="1" rx="2"/>
              <clipPath id="underwater-v"><rect x="-90" y="0" width="180" height="30"/></clipPath>
              <rect x="-60" y="-5" width="120" height="10" fill="rgba(0,100,180,0.3)" clip-path="url(#underwater-v)"/>
            </g>
            <text x="-60" y="20" fill="#ffaa00" font-size="10">${trimDeg}°</text>
            <text x="-60" y="30" fill="#6a8aa8" font-size="8">艏倾为正</text>
          </svg>
        </div>
      </div>

      <!-- 姿态状态 -->
      <div style="padding:6px;background:rgba(0,40,80,0.4);border-radius:4px;font-size:10px;color:#6a8aa8;text-align:center;">
        姿态状态: <span id="sm-attitude-status" style="color:${attitudeStatusColor};font-weight:600;">${attitudeStatus}</span>
      </div>
    `;
    this.container.appendChild(leftPanel);

    // ===== 右侧面板 =====
    const panel = document.createElement('div');
    panel.id = 'ship-motion-panel';
    panel.style.cssText = `
      position: absolute; top: 10px; right: 10px; z-index: 1002;
      width: 280px;
      background: rgba(8, 18, 38, 0.88);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(0, 212, 255, 0.3);
      border-radius: 12px;
      padding: 16px;
      color: #c0d8f0;
      font-size: 12px;
      line-height: 1.6;
      font-family: 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4), 0 0 16px rgba(0, 180, 255, 0.1);
      max-height: calc(100% - 20px);
      overflow-y: auto;
    `;

    panel.innerHTML = `
      <style>
        .sm-info-row { display:flex; align-items:center; gap:6px; margin:3px 0; }
        .sm-info-row label { color:#6a8aa8; font-size:10px; min-width:42px; flex-shrink:0; }
        .sm-info-row input[type="number"] {
          width:58px; background:rgba(0,30,60,0.8); border:1px solid rgba(0,212,255,0.3);
          border-radius:3px; color:#c0d8f0; padding:2px 4px; font-size:11px; text-align:right;
        }
        .sm-info-row input[type="number"]:focus { outline:none; border-color:#00d4ff; box-shadow:0 0 6px rgba(0,212,255,0.2); }
        .sm-info-row .sm-unit { color:#5a7a9a; font-size:9px; }
      </style>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;border-bottom:1px solid rgba(0,212,255,0.2);padding-bottom:8px;">
        <span style="color:#00d4ff;font-size:14px;font-weight:600;">船舶运动态势</span>
        <button id="ship-motion-close-btn" style="background:none;border:none;color:#6a8aa8;cursor:pointer;font-size:16px;padding:0 4px;">&times;</button>
      </div>

      <div style="margin-bottom:10px;padding:8px;background:rgba(0,30,60,0.5);border-radius:6px;">
        <div style="color:#00d4ff;font-size:12px;font-weight:600;margin-bottom:4px;">船舶信息</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:2px 12px;font-size:11px;color:#8ab4d8;">
          <span>船名: <span style="color:#fff;">${ship.name || '-'}</span></span>
          <span>类型: <span style="color:#fff;">${ship.type || '-'}</span></span>
          <span>MMSI: <span style="color:#fff;">${ship.mmsi || '-'}</span></span>
          <span>总吨: <span style="color:#fff;">${ship.tonnage || '-'}</span></span>
          <span>船长: <span style="color:#fff;">${ship.length || '-'}m</span></span>
          <span>船宽: <span style="color:#fff;">${ship.width || '-'}m</span></span>
          <span>航速: <span style="color:#fff;">${ship.speed || '-'}kn</span></span>
          <span>航向: <span style="color:#fff;">${ship.heading || '-'}°</span></span>
        </div>
      </div>

      <div style="margin-bottom:10px;">
        <div style="color:#ffaa00;font-size:12px;font-weight:600;margin-bottom:6px;">六点吃水 (m)</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;">
          <div style="text-align:center;"><div style="font-size:10px;color:#6a8aa8;margin-bottom:2px;">舶左</div><input type="number" id="sm-draft-fl" value="${(drafts.fl || 0).toFixed(1)}" step="0.1" style="width:100%;background:rgba(0,30,60,0.8);border:1px solid rgba(0,212,255,0.3);border-radius:4px;color:#c0d8f0;padding:3px 4px;font-size:11px;text-align:center;"></div>
          <div style="text-align:center;"><div style="font-size:10px;color:#6a8aa8;margin-bottom:2px;">舶中</div><input type="number" id="sm-draft-fc" value="${(drafts.fc || 0).toFixed(1)}" step="0.1" style="width:100%;background:rgba(0,30,60,0.8);border:1px solid rgba(0,212,255,0.3);border-radius:4px;color:#c0d8f0;padding:3px 4px;font-size:11px;text-align:center;"></div>
          <div style="text-align:center;"><div style="font-size:10px;color:#6a8aa8;margin-bottom:2px;">舶右</div><input type="number" id="sm-draft-fr" value="${(drafts.fr || 0).toFixed(1)}" step="0.1" style="width:100%;background:rgba(0,30,60,0.8);border:1px solid rgba(0,212,255,0.3);border-radius:4px;color:#c0d8f0;padding:3px 4px;font-size:11px;text-align:center;"></div>
          <div style="text-align:center;"><div style="font-size:10px;color:#6a8aa8;margin-bottom:2px;">艆左</div><input type="number" id="sm-draft-al" value="${(drafts.al || 0).toFixed(1)}" step="0.1" style="width:100%;background:rgba(0,30,60,0.8);border:1px solid rgba(0,212,255,0.3);border-radius:4px;color:#c0d8f0;padding:3px 4px;font-size:11px;text-align:center;"></div>
          <div style="text-align:center;"><div style="font-size:10px;color:#6a8aa8;margin-bottom:2px;">艆中</div><input type="number" id="sm-draft-ac" value="${(drafts.ac || 0).toFixed(1)}" step="0.1" style="width:100%;background:rgba(0,30,60,0.8);border:1px solid rgba(0,212,255,0.3);border-radius:4px;color:#c0d8f0;padding:3px 4px;font-size:11px;text-align:center;"></div>
          <div style="text-align:center;"><div style="font-size:10px;color:#6a8aa8;margin-bottom:2px;">艆右</div><input type="number" id="sm-draft-ar" value="${(drafts.ar || 0).toFixed(1)}" step="0.1" style="width:100%;background:rgba(0,30,60,0.8);border:1px solid rgba(0,212,255,0.3);border-radius:4px;color:#c0d8f0;padding:3px 4px;font-size:11px;text-align:center;"></div>
        </div>
      </div>

      <div style="margin-bottom:10px;padding:8px;background:rgba(0,30,60,0.5);border-radius:6px;">
        <div style="color:#00d4ff;font-size:12px;font-weight:600;margin-bottom:6px;">水深信息</div>
        <div class="sm-info-row">
          <label>航道水深</label>
          <input type="number" id="sm-depth" value="${hydrology.depth.toFixed(1)}" step="0.1" min="0">
          <span class="sm-unit">m</span>
        </div>
        <div class="sm-info-row">
          <label>最大吃水</label>
          <span id="sm-max-draft" style="color:#fff;font-size:11px;">${maxDraft.toFixed(1)}m</span>
        </div>
        <div class="sm-info-row">
          <label>富裕水深</label>
          <span id="sm-ukc" style="color:${ukcColor};font-weight:600;font-size:11px;">${ukc.toFixed(1)}m</span>
        </div>
        <div class="sm-info-row">
          <label>横移</label>
          <span id="sm-offset-display" style="color:#fff;font-size:11px;">${lateralOffset.toFixed(0)}m</span>
        </div>
      </div>

      <div style="margin-bottom:10px;padding:8px;background:rgba(0,30,60,0.5);border-radius:6px;">
        <div style="color:#00d4ff;font-size:12px;font-weight:600;margin-bottom:6px;">水文环境</div>
        <div class="sm-info-row">
          <label>流速</label>
          <input type="number" id="sm-current-speed" value="${hydrology.currentSpeed.toFixed(1)}" step="0.1" min="0">
          <span class="sm-unit">kn</span>
        </div>
        <div class="sm-info-row">
          <label>流向</label>
          <input type="number" id="sm-current-dir" value="${hydrology.currentDir}" step="1" min="0" max="360">
          <span class="sm-unit">°</span>
        </div>
        <div class="sm-info-row">
          <label>风速</label>
          <input type="number" id="sm-wind-speed" value="${hydrology.windSpeed.toFixed(1)}" step="0.1" min="0">
          <span class="sm-unit">m/s</span>
        </div>
        <div class="sm-info-row">
          <label>风向</label>
          <input type="number" id="sm-wind-dir" value="${hydrology.windDir}" step="1" min="0" max="360">
          <span class="sm-unit">°</span>
        </div>
      </div>

      <div style="margin-bottom:6px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <span style="color:#ffaa00;font-size:12px;font-weight:600;">航道横移位置</span>
          <span id="sm-lateral-value" style="color:#00d4ff;font-size:11px;">${lateralOffset.toFixed(0)}m</span>
        </div>
        <input type="range" id="sm-lateral-slider" min="-100" max="100" value="${lateralOffset}" step="1" style="width:100%;accent-color:#00d4ff;height:4px;">
        <div style="display:flex;justify-content:space-between;font-size:9px;color:#6a8aa8;margin-top:2px;">
          <span>-100m (左)</span><span>0 (中心)</span><span>+100m (右)</span>
        </div>
      </div>
    `;

    this.container.appendChild(panel);
    this._shipMotionPanelEl = panel;

    // ===== 绑定事件 =====
    const self = this;

    // 关闭按钮
    const closeBtn = panel.querySelector('#ship-motion-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', () => self.exitShipMotion());

    // 六点吃水输入框
    const draftIds = ['fl', 'fc', 'fr', 'al', 'ac', 'ar'];
    draftIds.forEach(id => {
      const input = panel.querySelector(`#sm-draft-${id}`);
      if (input) {
        input.addEventListener('change', () => {
          const newDrafts = {};
          draftIds.forEach(did => {
            newDrafts[did] = parseFloat(panel.querySelector(`#sm-draft-${did}`).value) || 0;
          });
          self._shipMotionDrafts = newDrafts;
          const newAttitude = self._calculateAttitude(newDrafts);

          // 更新3D船舶姿态
          if (self._shipMotionShipGroup && self._shipMotionShipGroup.innerGroup) {
            self._shipMotionShipGroup.innerGroup.rotation.x = newAttitude.trimAngle;
            self._shipMotionShipGroup.innerGroup.rotation.z = newAttitude.heelAngle;
          }

          // 更新左侧面板姿态
          const heelLeftEl = document.getElementById('sm-heel-left');
          const trimLeftEl = document.getElementById('sm-trim-left');
          if (heelLeftEl) heelLeftEl.textContent = (newAttitude.heelAngle * 180 / Math.PI).toFixed(2) + '°';
          if (trimLeftEl) trimLeftEl.textContent = (newAttitude.trimAngle * 180 / Math.PI).toFixed(2) + '°';

          // 更新姿态状态
          const statusEl = document.getElementById('sm-attitude-status');
          if (statusEl) {
            const absHeel = Math.abs(newAttitude.heelAngle * 180 / Math.PI);
            const absTrim = Math.abs(newAttitude.trimAngle * 180 / Math.PI);
            if (absHeel < 3 && absTrim < 2) {
              statusEl.textContent = '正常';
              statusEl.style.color = '#44ff44';
            } else if (absHeel < 5 && absTrim < 3) {
              statusEl.textContent = '注意';
              statusEl.style.color = '#ffaa00';
            } else {
              statusEl.textContent = '警告';
              statusEl.style.color = '#ff4444';
            }
          }

          // 更新SVG中的旋转角度（放大10倍用于视觉）
          const crossSvg = document.querySelector('#attitude-cross-section');
          if (crossSvg) {
            const shipRect = crossSvg.querySelector('.ship-rect-g');
            if (shipRect) shipRect.setAttribute('transform', `rotate(${(newAttitude.heelAngle * 180 / Math.PI) * 10}, 0, 0)`);
          }
          const longSvg = document.querySelector('#attitude-long-section');
          if (longSvg) {
            const shipRect = longSvg.querySelector('.ship-rect-g');
            if (shipRect) shipRect.setAttribute('transform', `rotate(${(newAttitude.trimAngle * 180 / Math.PI) * 10}, 0, 0)`);
          }

          // 更新富裕水深
          const newMax = Math.max(...Object.values(newDrafts));
          const newUkc = self._shipMotionHydrology.depth - newMax;
          const ukcEl = panel.querySelector('#sm-ukc');
          if (ukcEl) {
            ukcEl.textContent = newUkc.toFixed(1) + 'm';
            ukcEl.style.color = newUkc > 1 ? '#44ff44' : newUkc > 0 ? '#ffaa00' : '#ff4444';
          }

          // 更新最大吃水
          const maxDraftEl = panel.querySelector('#sm-max-draft');
          if (maxDraftEl) maxDraftEl.textContent = newMax.toFixed(1) + 'm';

          if (self._onShipMotionChange) {
            self._onShipMotionChange({ type: 'drafts', drafts: newDrafts, attitude: newAttitude });
          }
        });
      }
    });

    // 航道水深输入
    const depthInput = panel.querySelector('#sm-depth');
    if (depthInput) {
      depthInput.addEventListener('change', () => {
        const newDepth = parseFloat(depthInput.value) || 0;
        self._shipMotionHydrology.depth = newDepth;
        // 重新计算富裕水深
        const newMax = Math.max(...Object.values(self._shipMotionDrafts));
        const newUkc = newDepth - newMax;
        const ukcEl = panel.querySelector('#sm-ukc');
        if (ukcEl) {
          ukcEl.textContent = newUkc.toFixed(1) + 'm';
          ukcEl.style.color = newUkc > 1 ? '#44ff44' : newUkc > 0 ? '#ffaa00' : '#ff4444';
        }
        if (self._onShipMotionChange) {
          self._onShipMotionChange({ type: 'depth', depth: newDepth });
        }
      });
    }

    // 水文环境输入
    const currentSpeedInput = panel.querySelector('#sm-current-speed');
    const currentDirInput = panel.querySelector('#sm-current-dir');
    const windSpeedInput = panel.querySelector('#sm-wind-speed');
    const windDirInput = panel.querySelector('#sm-wind-dir');

    const updateHydrology = () => {
      self._shipMotionHydrology.currentSpeed = parseFloat(currentSpeedInput?.value) || 0;
      self._shipMotionHydrology.currentDir = parseFloat(currentDirInput?.value) || 0;
      self._shipMotionHydrology.windSpeed = parseFloat(windSpeedInput?.value) || 0;
      self._shipMotionHydrology.windDir = parseFloat(windDirInput?.value) || 0;
      if (self._onShipMotionChange) {
        self._onShipMotionChange({ type: 'hydrology', hydrology: self._shipMotionHydrology });
      }
    };

    [currentSpeedInput, currentDirInput, windSpeedInput, windDirInput].forEach(input => {
      if (input) input.addEventListener('change', updateHydrology);
    });

    // 横移slider
    const slider = panel.querySelector('#sm-lateral-slider');
    const sliderValue = panel.querySelector('#sm-lateral-value');
    if (slider) {
      slider.addEventListener('input', () => {
        const offset = parseFloat(slider.value) || 0;
        self._shipMotionLateralOffset = offset;
        if (sliderValue) sliderValue.textContent = offset.toFixed(0) + 'm';
        const offsetDisplay = panel.querySelector('#sm-offset-display');
        if (offsetDisplay) offsetDisplay.textContent = offset.toFixed(0) + 'm';

        // 偏移船舶组（船舶在原点，直接沿X轴偏移）
        if (self._shipMotionShipGroup && self._shipMotionShipGroup.outerGroup) {
          self._shipMotionShipGroup.outerGroup.position.x = offset;
        }

        if (self._onShipMotionChange) {
          self._onShipMotionChange({ type: 'lateralOffset', lateralOffset: offset });
        }
      });
    }
  }

  /**
   * 构建航道边界（笔直竖直半透明平面）
   * @private
   */
  _buildChannelBounds() {
    // 船舶长度和宽度作为参考
    const ship = this._shipMotionData || {};
    const L = ship.length || 80;
    const W = ship.width || 15;
    const halfSpan = L * 1.2; // 航道宽度约 2.4 倍船长
    const wallHeight = 15; // 边界墙高度
    const wallLen = 200; // 边界长度（沿船舶方向）

    const wallMat = new THREE.MeshBasicMaterial({
      color: 0x0088ff,
      transparent: true,
      opacity: 0.06,
      side: THREE.DoubleSide,
      depthWrite: false
    });

    // 左边界
    const wallGeo = new THREE.PlaneGeometry(wallLen, wallHeight);
    const leftWall = new THREE.Mesh(wallGeo, wallMat);
    leftWall.position.set(0, wallHeight / 2 - 5, -halfSpan);
    this._shipMotionGroup.add(leftWall);

    // 右边界
    const rightWall = new THREE.Mesh(wallGeo.clone(), wallMat);
    rightWall.position.set(0, wallHeight / 2 - 5, halfSpan);
    this._shipMotionGroup.add(rightWall);

    // 边界顶部线
    const lineMat = new THREE.LineBasicMaterial({ color: 0x00aaff, transparent: true, opacity: 0.5 });
    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-wallLen / 2, wallHeight - 5, -halfSpan),
      new THREE.Vector3(wallLen / 2, wallHeight - 5, -halfSpan),
    ]);
    this._shipMotionGroup.add(new THREE.Line(lineGeo, lineMat));

    const lineGeo2 = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-wallLen / 2, wallHeight - 5, halfSpan),
      new THREE.Vector3(wallLen / 2, wallHeight - 5, halfSpan),
    ]);
    this._shipMotionGroup.add(new THREE.Line(lineGeo2, lineMat));

    // 水面处的边界线（Y=0）
    const waterLineMat = new THREE.LineBasicMaterial({ color: 0x00ccff, transparent: true, opacity: 0.4 });
    [-halfSpan, halfSpan].forEach(z => {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-wallLen / 2, 0.1, z),
        new THREE.Vector3(wallLen / 2, 0.1, z),
      ]);
      this._shipMotionGroup.add(new THREE.Line(geo, waterLineMat));
    });
  }

  /**
   * 退出船舶运动态势模式，清理所有资源
   */
  exitShipMotion() {
    this._isShipMotion = false;
    if (this.scene && this._shipMotionGroup.parent === this.scene) {
      this.scene.remove(this._shipMotionGroup);
    }
    this._clearGroup(this._shipMotionGroup);
    this._currentArrows = [];
    this._windArrows = [];
    if (this._shipMotionPanelEl) {
      if (this._shipMotionPanelEl.parentNode) this._shipMotionPanelEl.parentNode.removeChild(this._shipMotionPanelEl);
      this._shipMotionPanelEl = null;
    }
    // 清理左侧姿态面板
    const leftPanelEl = document.getElementById('ship-motion-attitude-panel');
    if (leftPanelEl && leftPanelEl.parentNode) leftPanelEl.parentNode.removeChild(leftPanelEl);
    this._shipMotionData = null;
    this._shipMotionHydrology = null;
    this._shipMotionDrafts = null;
    this._shipMotionShipGroup = null;
    if (this._composerBackup) {
      this.composerEnabled = true;
      delete this._composerBackup;
    }
    console.log('[Channel3D] 已退出船舶运动态势模式');
  }

  /**
   * 退出侧面剖视图模式，恢复到全航道视图
   *
   * 清理内容:
   *   1. 重置 _isCrossSection 标志
   *   2. 从场景中移除并清空 _crossSectionGroup
   *   3. 清空深度网格缓存
   *   4. 重置当前航段信息
   *
   * 注意: 剖视图模式下的船舶模型在 _crossSectionGroup 中，无需清理 shipGroup
   */
  exitCrossSection() {
    this._isCrossSection = false;

    // 步骤1: 从场景中移除剖视图专用组并清空所有子对象
    if (this.scene && this._crossSectionGroup.parent === this.scene) {
      this.scene.remove(this._crossSectionGroup);
    }
    this._clearGroup(this._crossSectionGroup);

    // 步骤2: 清空深度网格缓存（单航段的深度数据不再需要）
    this._depthGridData = null;
    this._depthGridMeta = null;

    // 步骤3: 重置当前航段信息
    this.currentSegment = null;
    this.currentSegId = null;
  }

  /* ===== 通用资源清理方法 ===== */

  /**
   * 递归清理对象组中的所有子对象
   * 遍历并释放每个子 Mesh 的 Geometry 和 Material，然后移除
   * 这是场景对象回收的核心方法，每次构建新场景前都会调用
   * @param {THREE.Group} group - 要清理的 THREE.Group
   * @private
   */
  _clearGroup(group) {
    while (group.children.length > 0) {
      const child = group.children[0];
      group.remove(child);

      // 递归清理子 Group
      if (child.children && child.children.length > 0) {
        this._clearGroup(child);
      }

      // 清理灯光资源
      if (child.dispose && typeof child.dispose === 'function' && !child.geometry && !child.material) {
        child.dispose();
      }

      if (child.geometry) {
        child.geometry.dispose();
      }
      if (child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach(m => {
            if (m.map) m.map.dispose();
            m.dispose();
          });
        } else {
          if (child.material.map) child.material.map.dispose();
          child.material.dispose();
        }
      }
    }
  }

  /* ===== 资源清理与销毁 ===== */

  /**
   * 销毁实例，释放所有 Three.js 资源并移除事件监听
   * 调用后实例不可再使用，需重新创建
   *
   * 清理顺序:
   *   1. 设置 _disposed 标志，停止动画循环
   *   2. 取消 requestAnimationFrame
   *   3. 移除 window.resize 事件监听
   *   4. 清理所有场景对象组（terrain/water/ship/boundary/crossSection）
   *   5. 清理扫光效果（光点、拖尾、路径缓存）
   *   6. 销毁 OrbitControls
   *   7. 销毁 WebGLRenderer 并移除 canvas 元素
   *   8. 清空所有缓存数据引用
   */
  dispose() {
    this._disposed = true; // 设置已销毁标志，动画循环将在下一帧终止

    // 停止动画循环
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }

    // 移除窗口大小变化事件监听
    if (this._onResize) {
      window.removeEventListener('resize', this._onResize);
      this._onResize = null;
    }

    // 清理各场景对象组（释放几何体和材质）
    this._clearGroup(this.terrainGroup);
    this._clearGroup(this.waterGroup);
    this._clearGroup(this.shipGroup);
    this._clearGroup(this.boundaryGroup);
    this._clearGroup(this._crossSectionGroup);
    // 清理船舶运动态势专用组
    this._clearGroup(this._shipMotionGroup);
    if (this.scene && this._shipMotionGroup.parent === this.scene) {
      this.scene.remove(this._shipMotionGroup);
    }
    this._currentArrows = [];
    this._windArrows = [];
    this._shipMotionData = null;
    this._shipMotionHydrology = null;
    this._shipMotionDrafts = null;
    this._shipMotionShipGroup = null;
    this._onShipMotionChange = null;
    // 移除运动态势DOM面板
    if (this._shipMotionPanelEl) {
      if (this._shipMotionPanelEl.parentNode) {
        this._shipMotionPanelEl.parentNode.removeChild(this._shipMotionPanelEl);
      }
      this._shipMotionPanelEl = null;
    }

    // 清理扫光效果
    if (this._scanLight) {
      if (this._scanLight.geometry) this._scanLight.geometry.dispose();
      if (this._scanLight.material) this._scanLight.material.dispose();
      this._scanLight = null;
    }
    this._scanTrail = [];
    this._scanPath = [];

    // 销毁轨道控制器
    if (this.controls) {
      this.controls.dispose();
      this.controls = null;
    }

    // 销毁WebGL渲染器并移除canvas元素
    if (this.renderer) {
      this.renderer.dispose();
      if (this.renderer.domElement && this.renderer.domElement.parentNode) {
        this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
      }
      this.renderer = null;
    }

    // 清空所有缓存数据引用，帮助GC回收
    this._depthGridData = null;
    this._depthGridMeta = null;
    this.currentSegment = null;
    this._cameraAnim = null;

    // 清理后处理管线
    if (this._composer) { this._composer.dispose(); this._composer = null; }
    this._bloomPass = null;
    this._fxaaPass = null;

    // 清理CSS2D标签系统
    if (this._labelGroup) {
      this._labelGroup.traverse(child => {
        if (child.isCSS2DObject && child.element && child.element.parentNode) {
          child.element.parentNode.removeChild(child.element);
        }
      });
      this.scene.remove(this._labelGroup);
      this._labelGroup = null;
    }
    if (this._labelRenderer && this._labelRenderer.domElement && this._labelRenderer.domElement.parentNode) {
      this._labelRenderer.domElement.parentNode.removeChild(this._labelRenderer.domElement);
      this._labelRenderer = null;
    }

    // 停止自动巡航
    this.stopAutoTour();

    console.log('[Channel3D] 资源已清理');
  }

  /* ===== 数据导入接口 ===== */

  /**
   * 导入真实航道水深数据
   * 替换 generateDepthGrid() 的模拟数据
   *
   * @param {Array<{lat: number, lng: number, depth: number}>} depthPoints - 水深测点数据
   *   - lat: 纬度
   *   - lng: 经度
   *   - depth: 水深(米, 正值表示水面以下)
   * @param {object} [gridOptions] - 网格插值选项
   *   - width: 网格宽度(默认64)
   *   - height: 网格高度(默认64)
   *   - method: 插值方法('idw'反距离加权, 'kriging'克里金, 默认'idw')
   *
   * @example
   * // 从JSON文件加载水深数据
   * const depthData = await fetch('data/depth_survey.json').then(r => r.json());
   * channel3D.loadDepthData(depthData.points);
   *
   * // 从GeoTIFF加载(需要额外库支持)
   * // const geoTiff = await parseGeoTIFF(url);
   * // channel3D.loadDepthData(geoTiff.rasterToPoints());
   */
  loadDepthData(depthPoints, gridOptions = {}) {
    if (!depthPoints || depthPoints.length === 0) {
      console.warn('[Channel3D] 水深数据为空');
      return;
    }

    this._externalDepthData = depthPoints;
    console.log(`[Channel3D] 已导入 ${depthPoints.length} 个水深测点`);

    // 如果当前已有航段加载，立即重新构建地形
    if (this.currentSegment) {
      const { channelData, segId } = this.currentSegment;
      this.buildTerrain(channelData, segId);
      this.buildWaterSurface(channelData);
      this.buildShips(this._lastShips || [], segId);
    }
  }

  /**
   * 导入真实船舶吃水数据
   * 替换随机生成的吃水值
   *
   * @param {Array<{name: string, draft: number}>} draftData - 船舶吃水数据
   *   - name: 船名(用于匹配)
   *   - draft: 吃水深度(米, 水线以下)
   *
   * @example
   * // 从AIS报文解析吃水
   * const draftData = [
   *   { name: '华融横滨', draft: 6.5 },
   *   { name: '永兴128', draft: 4.2 },
   * ];
   * channel3D.loadShipDraftData(draftData);
   *
   * // 或从JSON文件批量导入
   * const data = await fetch('data/ship_drafts.json').then(r => r.json());
   * channel3D.loadShipDraftData(data);
   */
  loadShipDraftData(draftData) {
    if (!draftData || draftData.length === 0) {
      console.warn('[Channel3D] 吃水数据为空');
      return;
    }

    this._externalDraftData = draftData;
    console.log(`[Channel3D] 已导入 ${draftData.length} 艘船的吃水数据`);

    // 如果当前已有船舶加载，立即更新
    if (this._lastShips && this._lastShips.length > 0) {
      const updatedShips = this._lastShips.map(ship => {
        const draftEntry = draftData.find(d => d.name === ship.name);
        if (draftEntry) {
          return { ...ship, draft: draftEntry.draft };
        }
        return ship;
      });
      this.buildShips(updatedShips, this.currentSegId);
    }
  }
}
