/**
 * ChannelPanorama - 大屏级伪3D全景态势视图
 *
 * 基于 Canvas 2D 的伪3D航道全景态势视图，智慧城市/数据大屏风格。
 * 左键拖拽旋转视角、右键平移、滚轮缩放。
 * 深色背景 + 霓虹发光线条 + 透视网格地面 + 粒子飘浮。
 */

// ======================== 常量与配置 ========================

const METERS_PER_DEG_LAT = 111000;
const FOCAL_LENGTH = 800;
const V_SCALE = 1.2;
const FONT_FAMILY = "'Microsoft YaHei', 'PingFang SC', sans-serif";

/** 3D航段块的高度（像素，用于绘制侧面） */
const BLOCK_HEIGHT = 18;
/** 网格地面在画面中的Y比例 */
const GRID_Y_RATIO = 0.88;

/** 视觉配色 */
const COLORS = {
  bgTop: '#020810',
  bgBottom: '#0a1628',
  accent: '#00d4ff',
  accentDim: '#006680',
  border: '#1e4a6e',
  warning: '#ff4444',
  warningGlow: 'rgba(255,68,68,0.3)',
  text: '#c8dce8',
  textDim: '#5a7a9a',
  grid: '#0d2a44',
  gridBright: '#1a4a6e',
  particle: '#00d4ff',
  riskHigh: '#ff4444',
  riskMedium: '#ffaa00',
  riskLow: '#4488ff',
  shipConstruction: '#ff6b35',
  shipCargo: '#00d4ff',
  blockSide: '#061828',
  hoverGlow: 'rgba(0,212,255,0.6)',
};

const RISK_COLORS = { high: COLORS.riskHigh, medium: COLORS.riskMedium, low: COLORS.riskLow };
const SHIP_COLORS = { construction: COLORS.shipConstruction, cargo: COLORS.shipCargo };
const BOUNDARY_COLORS = { main: COLORS.accent, centerline: COLORS.accent, warning: COLORS.warning };

// ======================== 工具函数 ========================

function geoToLocal(lat, lng, centerLat, centerLng) {
  const x = (lng - centerLng) * METERS_PER_DEG_LAT * Math.cos(centerLat * Math.PI / 180);
  const z = (lat - centerLat) * METERS_PER_DEG_LAT;
  return { x, z };
}

function lerp(a, b, t) { return a + (b - a) * Math.max(0, Math.min(1, t)); }

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function vecAngle(dx, dz) { return Math.atan2(dx, dz); }

function rotatePoint(x, z, angle) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return { x: x * cos - z * sin, z: x * sin + z * cos };
}

function pointInPolygon(px, pz, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, zi = polygon[i].z;
    const xj = polygon[j].x, zj = polygon[j].z;
    if (((zi > pz) !== (zj > pz)) && (px < (xj - xi) * (pz - zi) / (zj - zi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function riskScoreToColor(risk) {
  if (risk >= 0.7) return RISK_COLORS.high;
  if (risk >= 0.4) return RISK_COLORS.medium;
  return RISK_COLORS.low;
}

function riskScoreToText(risk) {
  if (risk >= 0.7) return '高风险';
  if (risk >= 0.4) return '中风险';
  return '正常';
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function seededRandom(seed) {
  let s = seed;
  return function () {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** 判断屏幕坐标点是否在投影多边形内 */
function pointInScreenPoly(px, py, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].sx, yi = polygon[i].sy;
    const xj = polygon[j].sx, yj = polygon[j].sy;
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/** 绘制圆角矩形路径 */
function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

// ======================== 主类 ========================

export class ChannelPanorama {

  constructor(containerId) {
    this.containerId = containerId;
    this.container = null;

    // Canvas
    this.canvas = null;
    this.ctx = null;
    this.dpr = 1;
    this.width = 0;
    this.height = 0;

    // 数据
    this.channelData = null;
    this.segments = [];
    this.ships = [];
    this.risks = {};

    // 投影缓存
    this._projectionCache = null;
    this._centerLat = 0;
    this._centerLng = 0;
    this._mainAngle = 0;
    this._depthRange = { min: 0, max: 0 };
    this._acrossRange = 2000;

    // 视图状态
    this._mode = 'panorama';
    this._selectedSegId = -1;
    this._selectedShipIdx = 0;
    this._hoveredSegId = -1;
    this._hoveredShipId = -1;
    this._hoverProgress = 0;
    this._transitioning = false;
    this._transitionProgress = 0;

    // 动画
    this._animationId = null;
    this._disposed = false;
    this._time = 0;
    this._visible = false;

    // 粒子
    this._particles = [];

    // 鼠标
    this._mouseX = 0;
    this._mouseY = 0;

    // 视图变换
    this._viewZoom = 1;
    this._viewRotation = 0;    // 弧度
    this._viewPanX = 0;
    this._viewPanY = 0;
    this._viewTilt = 0.55;    // 固定俯仰倾斜（弧度），模拟大屏3D视角
    this._isDragging = false;
    this._dragButton = -1;
    this._dragStartX = 0;
    this._dragStartY = 0;
    this._dragStartRotX = 0;  // 水平旋转起始值
    this._dragStartRotY = 0;  // 垂直旋转起始值
    this._dragStartPanX = 0;
    this._dragStartPanY = 0;
    this._dragMoved = false;

    // 回调
    this.onSegmentClick = null;
    this.onBack = null;
    this.onEnter3D = null;

    // UI按钮
    this._buttons = [];

    // 网格地面参数
    this._gridAngleH = 0;  // 由viewRotation决定
  }

  // -------------------- 初始化 --------------------

  init() {
    this.container = document.getElementById(this.containerId);
    if (!this.container) {
      console.error(`[ChannelPanorama] Container not found: ${this.containerId}`);
      return;
    }

    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'width:100%;height:100%;display:block;cursor:grab;';
    this.container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    // 事件绑定
    this._onMouseMove = this._handleMouseMove.bind(this);
    this._onClick = this._handleClick.bind(this);
    this._onResize = this._handleResize.bind(this);
    this._onWheel = this._handleWheel.bind(this);
    this._onMouseDown = this._handleMouseDown.bind(this);
    this._onMouseUp = this._handleMouseUp.bind(this);
    this._onContextMenu = (e) => e.preventDefault();

    this.canvas.addEventListener('mousemove', this._onMouseMove);
    this.canvas.addEventListener('click', this._onClick);
    this.canvas.addEventListener('wheel', this._onWheel, { passive: false });
    this.canvas.addEventListener('mousedown', this._onMouseDown);
    this.canvas.addEventListener('mouseup', this._onMouseUp);
    this.canvas.addEventListener('contextmenu', this._onContextMenu);
    window.addEventListener('resize', this._onResize);

    this._handleResize();
    this._initParticles();

    console.log('[ChannelPanorama] 初始化完成');
  }

  // -------------------- 数据设置 --------------------

  setData(channelData, segments, ships, risks) {
    this.channelData = channelData;
    this.segments = segments || [];
    this.ships = ships || [];
    this.risks = risks || {};
    this._computeProjection();
  }

  // -------------------- 显示/隐藏 --------------------

  show() {
    if (!this.canvas) return;
    this._visible = true;
    this.canvas.style.display = 'block';
    this._handleResize();
    if (!this._animationId) {
      this._animate();
    }
  }

  hide() {
    this._visible = false;
    if (this._animationId) {
      cancelAnimationFrame(this._animationId);
      this._animationId = null;
    }
    if (this.canvas) this.canvas.style.display = 'none';
  }

  dispose() {
    this._disposed = true;
    this._visible = false;
    if (this._animationId) {
      cancelAnimationFrame(this._animationId);
      this._animationId = null;
    }
    if (this.canvas) {
      this.canvas.removeEventListener('mousemove', this._onMouseMove);
      this.canvas.removeEventListener('click', this._onClick);
      this.canvas.removeEventListener('wheel', this._onWheel);
      this.canvas.removeEventListener('mousedown', this._onMouseDown);
      this.canvas.removeEventListener('mouseup', this._onMouseUp);
      this.canvas.removeEventListener('contextmenu', this._onContextMenu);
    }
    window.removeEventListener('resize', this._onResize);
    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
    this.canvas = null;
    this.ctx = null;
    this._projectionCache = null;
    this._particles = [];
    console.log('[ChannelPanorama] 资源已清理');
  }

  // -------------------- 投影计算 --------------------

  _computeProjection() {
    if (!this.channelData || !this.segments.length) return;

    const allPoints = [];
    const channels = ['south_channel_lower', 'south_channel_upper', 'south_branch'];
    channels.forEach(ch => {
      const data = this.channelData[ch];
      if (data) {
        if (data.north_boundary) allPoints.push(...data.north_boundary);
        if (data.south_boundary) allPoints.push(...data.south_boundary);
        if (data.centerline) allPoints.push(...data.centerline);
      }
    });
    ['jiuduansha_warning', 'yuanyuansha_warning'].forEach(key => {
      const data = this.channelData[key];
      if (data) allPoints.push(...data);
    });

    let sumLat = 0, sumLng = 0;
    allPoints.forEach(p => { sumLat += p[0]; sumLng += p[1]; });
    this._centerLat = sumLat / allPoints.length;
    this._centerLng = sumLng / allPoints.length;

    // 主航道方向
    const mainLower = this.channelData.south_channel_lower;
    const mainUpper = this.channelData.south_channel_upper;
    const mainCenterline = [
      ...(mainLower ? mainLower.centerline || [] : []),
      ...(mainUpper ? mainUpper.centerline || [] : [])
    ];
    if (mainCenterline.length >= 2) {
      const first = geoToLocal(mainCenterline[0][0], mainCenterline[0][1], this._centerLat, this._centerLng);
      const last = geoToLocal(mainCenterline[mainCenterline.length - 1][0], mainCenterline[mainCenterline.length - 1][1], this._centerLat, this._centerLng);
      this._mainAngle = vecAngle(last.x - first.x, last.z - first.z);
    }

    // 深度范围
    let minZ = Infinity, maxZ = -Infinity;
    allPoints.forEach(p => {
      const local = geoToLocal(p[0], p[1], this._centerLat, this._centerLng);
      const rotated = rotatePoint(local.x, local.z, -this._mainAngle);
      if (rotated.z < minZ) minZ = rotated.z;
      if (rotated.z > maxZ) maxZ = rotated.z;
    });
    this._depthRange = { min: minZ, max: maxZ };

    // 横向范围
    let minAcross = Infinity, maxAcross = -Infinity;
    allPoints.forEach(p => {
      const local = geoToLocal(p[0], p[1], this._centerLat, this._centerLng);
      const rotated = rotatePoint(local.x, local.z, -this._mainAngle);
      if (rotated.x < minAcross) minAcross = rotated.x;
      if (rotated.x > maxAcross) maxAcross = rotated.x;
    });
    this._acrossRange = Math.max(Math.abs(minAcross), Math.abs(maxAcross), 1000);

    this._buildProjectionCache();
  }

  _buildProjectionCache() {
    this._projectionCache = { segments: [], ships: [] };

    this.segments.forEach(seg => {
      if (!seg.coords || seg.coords.length < 3) return;
      const polygon = seg.coords.map(p => this._projectPoint(p[0], p[1]));
      let center;
      if (seg.center) {
        center = this._projectPoint(seg.center[0], seg.center[1]);
      } else {
        let cx = 0, cy = 0;
        polygon.forEach(p => { cx += p.sx; cy += p.sy; });
        center = { sx: cx / polygon.length, sy: cy / polygon.length, depth: 0, scale: 1 };
      }
      this._projectionCache.segments.push({
        id: seg.id,
        name: seg.name,
        type: seg.type,
        polygon: polygon,
        center: center,
        risk: this.risks[seg.id] || 0
      });
    });

    this.ships.forEach(ship => {
      if (ship._lat !== undefined && ship._lng !== undefined) {
        const projected = this._projectPoint(ship._lat, ship._lng);
        this._projectionCache.ships.push({ ...ship, projected: projected });
      }
    });
  }

  /**
   * 核心投影：经纬度 → 屏幕坐标
   * 叠加左键旋转产生的 _viewRotation（绕视图中心旋转整个场景）
   */
  _projectPoint(lat, lng) {
    const local = geoToLocal(lat, lng, this._centerLat, this._centerLng);
    const rotated = rotatePoint(local.x, local.z, -this._mainAngle);

    const depthRange = this._depthRange.max - this._depthRange.min;
    const rawDepth = rotated.z - this._depthRange.min;
    const normalizedDepth = depthRange > 0 ? rawDepth / depthRange : 0.5;

    const virtualDepth = normalizedDepth * 600;
    const across = rotated.x;

    const acrossRange = this._acrossRange || 2000;
    const normalizedAcross = across / acrossRange * 200;

    const scale = FOCAL_LENGTH / (FOCAL_LENGTH + virtualDepth);

    const centerX = this.width / 2;
    const bottomY = this.height * GRID_Y_RATIO;

    const sx = centerX + normalizedAcross * scale;
    const sy = bottomY - virtualDepth * scale * V_SCALE;

    // 视图变换：缩放 → 旋转 → 平移
    const viewCX = this.width / 2 + this._viewPanX;
    const viewCY = this.height / 2 + this._viewPanY;

    const zoomedSx = viewCX + (sx - this.width / 2) * this._viewZoom;
    const zoomedSy = viewCY + (sy - this.height / 2) * this._viewZoom;

    // 绕视图中心旋转
    const cos = Math.cos(this._viewRotation);
    const sin = Math.sin(this._viewRotation);
    const rotSx = viewCX + (zoomedSx - viewCX) * cos - (zoomedSy - viewCY) * sin;
    const rotSy = viewCY + (zoomedSx - viewCX) * sin + (zoomedSy - viewCY) * cos;

    return { sx: rotSx, sy: rotSy, depth: normalizedDepth, scale: scale * this._viewZoom, across: normalizedAcross };
  }

  _reproject() {
    if (this._projectionCache) {
      this._buildProjectionCache();
    }
  }

  // -------------------- 粒子系统 --------------------

  _initParticles() {
    this._particles = [];
    const rng = seededRandom(42);
    for (let i = 0; i < 120; i++) {
      this._particles.push({
        x: rng(),
        y: rng(),
        z: rng(),  // 深度层次
        size: 0.5 + rng() * 2.5,
        speed: 0.0001 + rng() * 0.0004,
        drift: (rng() - 0.5) * 0.0002,
        alpha: 0.08 + rng() * 0.25,
        phase: rng() * Math.PI * 2
      });
    }
  }

  // -------------------- 事件处理 --------------------

  _handleResize() {
    if (!this.canvas || !this.container) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.width = w;
    this.height = h;
    this.canvas.width = w * this.dpr;
    this.canvas.height = h * this.dpr;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this._reproject();
  }

  _handleMouseDown(e) {
    if (this._mode !== 'panorama') return;

    this._isDragging = true;
    this._dragButton = e.button;
    this._dragStartX = e.clientX;
    this._dragStartY = e.clientY;
    this._dragMoved = false;

    if (e.button === 0) {
      // 左键：旋转
      this._dragStartRotX = this._viewRotation;
      this._dragStartRotY = this._viewTilt;
    } else if (e.button === 2) {
      // 右键：平移
      this._dragStartPanX = this._viewPanX;
      this._dragStartPanY = this._viewPanY;
    }
    this.canvas.style.cursor = e.button === 0 ? 'grabbing' : 'move';
  }

  _handleMouseUp(e) {
    if (!this._isDragging) return;

    if (e.button === 0 && this._dragMoved) {
      // 左键拖拽完成 - 旋转已实时应用
    } else if (e.button === 2 && this._dragMoved) {
      // 右键拖拽完成 - 平移已实时应用
    }
    // 如果左键几乎没有移动，视为点击（在 _handleClick 中处理）

    this._isDragging = false;
    this.canvas.style.cursor = this._mode === 'panorama' ? 'grab' : 'default';
    this._buildProjectionCache();
  }

  _handleMouseMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    this._mouseX = e.clientX - rect.left;
    this._mouseY = e.clientY - rect.top;

    if (this._isDragging) {
      const dx = e.clientX - this._dragStartX;
      const dy = e.clientY - this._dragStartY;

      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        this._dragMoved = true;
      }

      if (this._dragButton === 0) {
        // 左键拖拽：水平旋转
        this._viewRotation = this._dragStartRotX + dx * 0.003;
        // 限制旋转范围在 [-PI/3, PI/3]
        this._viewRotation = Math.max(-Math.PI / 3, Math.min(Math.PI / 3, this._viewRotation));
        this._buildProjectionCache();
      } else if (this._dragButton === 2) {
        // 右键拖拽：平移
        this._viewPanX = this._dragStartPanX + dx;
        this._viewPanY = this._dragStartPanY + dy;
        this._buildProjectionCache();
      }
      return;
    }

    if (this._mode === 'panorama') {
      this._updateHover();
      const hitShip = this._hitTestShip(this._mouseX, this._mouseY);
      this._hoveredShipId = hitShip ? hitShip.name : null;
      this.canvas.style.cursor = (hitShip || this._hoveredSegId >= 0) ? 'pointer' : 'grab';
    }
  }

  _handleClick(e) {
    if (this._dragMoved) return; // 拖拽中不触发点击

    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // 检查按钮
    for (const btn of this._buttons) {
      if (mx >= btn.x && mx <= btn.x + btn.w && my >= btn.y && my <= btn.y + btn.h) {
        btn.action();
        return;
      }
    }

    if (this._mode === 'panorama') {
      const hitShip = this._hitTestShip(mx, my);
      if (hitShip) {
        this._selectedShipIdx = this.ships.findIndex(s => s.name === hitShip.name);
        this._enterDetail(hitShip.segment);
        return;
      }
      const hitSeg = this._hitTestSegment(mx, my);
      if (hitSeg >= 0) {
        this._selectedShipIdx = 0;
        this._enterDetail(hitSeg);
      }
    } else if (this._mode === 'detail') {
      const hitShipBtn = this._hitTestShipButton(mx, my);
      if (hitShipBtn >= 0) {
        this._selectedShipIdx = hitShipBtn;
      }
    }
  }

  _handleWheel(e) {
    e.preventDefault();
    if (this._mode !== 'panorama') return;
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    this._viewZoom = Math.max(0.3, Math.min(5, this._viewZoom * delta));
    this._buildProjectionCache();
  }

  // -------------------- 命中检测 --------------------

  _hitTestSegment(mx, my) {
    if (!this._projectionCache) return -1;
    for (let i = this._projectionCache.segments.length - 1; i >= 0; i--) {
      const seg = this._projectionCache.segments[i];
      if (pointInScreenPoly(mx, my, seg.polygon)) {
        return seg.id;
      }
    }
    return -1;
  }

  _hitTestShip(mx, my) {
    if (!this._projectionCache) return null;
    for (const ship of this._projectionCache.ships) {
      if (!ship.projected) continue;
      const p = ship.projected;
      const size = Math.max(8, 14 * p.scale);
      const dx = mx - p.sx, dy = my - p.sy;
      if (dx * dx + dy * dy < (size + 8) * (size + 8)) return ship;
    }
    return null;
  }

  _hitTestShipButton(mx, my) {
    for (const btn of this._buttons) {
      if (btn.shipIdx !== undefined && mx >= btn.x && mx <= btn.x + btn.w && my >= btn.y && my <= btn.y + btn.h) {
        return btn.shipIdx;
      }
    }
    return -1;
  }

  _updateHover() {
    const hitSeg = this._hitTestSegment(this._mouseX, this._mouseY);
    if (hitSeg !== this._hoveredSegId) {
      this._hoveredSegId = hitSeg;
    }
  }

  _isAdjacent(id1, id2) { return Math.abs(id1 - id2) === 1; }

  // -------------------- 视图切换 --------------------

  _enterDetail(segId) {
    this._selectedSegId = segId;
    this._mode = 'detail';
    this._transitioning = true;
    this._transitionProgress = 0;
    this.canvas.style.cursor = 'default';
    if (this.onSegmentClick) this.onSegmentClick(segId);
  }

  _backToPanorama() {
    this._mode = 'panorama';
    this._selectedSegId = -1;
    this._hoveredSegId = -1;
    this._transitioning = true;
    this._transitionProgress = 0;
    if (this.onBack) this.onBack();
  }

  _enter3DView() {
    if (this.onEnter3D && this._selectedSegId >= 0) {
      this.onEnter3D(this._selectedSegId);
    }
  }

  // -------------------- 动画循环 --------------------

  _animate() {
    if (this._disposed) return;
    this._animationId = requestAnimationFrame(() => this._animate());
    if (!this._visible) return;

    this._time = performance.now() * 0.001;

    if (this._transitioning) {
      this._transitionProgress = Math.min(this._transitionProgress + 0.02, 1);
      if (this._transitionProgress >= 1) this._transitioning = false;
    }

    const targetHover = this._hoveredSegId >= 0 ? 1 : 0;
    this._hoverProgress = lerp(this._hoverProgress, targetHover, 0.1);

    this._render();
  }

  // -------------------- 渲染 --------------------

  _render() {
    const ctx = this.ctx;
    const w = this.width, h = this.height;

    ctx.fillStyle = COLORS.bgBottom;
    ctx.fillRect(0, 0, w, h);

    this._buttons = [];

    if (this._mode === 'panorama') {
      this._renderPanorama(ctx, w, h);
    } else if (this._mode === 'detail') {
      this._renderDetail(ctx, w, h);
    }
  }

  // ==================== 全景视图 ====================

  _renderPanorama(ctx, w, h) {
    const t = this._time;
    const transT = this._transitioning ? easeInOutCubic(this._transitionProgress) : 1;

    // 1. 深色背景渐变
    this._drawBackground(ctx, w, h, t);

    // 2. 透视网格地面
    this._drawGridFloor(ctx, w, h, t);

    // 3. 粒子
    this._drawParticles(ctx, w, h, t);

    // 4. 航段（3D块，从远到近）
    if (this._projectionCache) {
      for (let i = 0; i < this._projectionCache.segments.length; i++) {
        const seg = this._projectionCache.segments[i];
        const isHovered = seg.id === this._hoveredSegId;
        const isAdjacent = this._hoveredSegId >= 0 && !isHovered && this._isAdjacent(seg.id, this._hoveredSegId);
        this._drawSegment3D(ctx, seg, isHovered, isAdjacent, transT);
      }
    }

    // 5. 边界线（霓虹发光）
    if (this._projectionCache) {
      this._drawBoundaryLines(ctx, transT);
    }

    // 6. 航道中线
    if (this._projectionCache) {
      this._drawCenterlines(ctx, transT);
    }

    // 7. 船舶
    if (this._projectionCache) {
      this._projectionCache.ships.forEach(ship => this._drawShip(ctx, ship, transT));
    }

    // 8. 悬停详情卡
    if (this._hoveredSegId >= 0 && this._projectionCache) {
      const seg = this._projectionCache.segments.find(s => s.id === this._hoveredSegId);
      if (seg) this._drawTooltip(ctx, seg);
    }

    // 9. HUD标题
    this._drawHUD(ctx, w, h, t);
  }

  // --- 背景 ---

  _drawBackground(ctx, w, h, t) {
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, COLORS.bgTop);
    grad.addColorStop(0.4, '#060e1c');
    grad.addColorStop(0.75, '#0a1628');
    grad.addColorStop(1, '#0d1f3c');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // 大气光晕（底部微光）
    const glow1 = ctx.createRadialGradient(w * 0.5, h * 0.95, 0, w * 0.5, h * 0.95, h * 0.6);
    glow1.addColorStop(0, 'rgba(0,100,140,0.06)');
    glow1.addColorStop(1, 'rgba(0,40,60,0)');
    ctx.fillStyle = glow1;
    ctx.fillRect(0, 0, w, h);

    // 角落微光
    const glow2 = ctx.createRadialGradient(0, 0, 0, 0, 0, h * 0.4);
    glow2.addColorStop(0, 'rgba(0,80,120,0.03)');
    glow2.addColorStop(1, 'rgba(0,20,40,0)');
    ctx.fillStyle = glow2;
    ctx.fillRect(0, 0, w, h);
  }

  // --- 透视网格地面 ---

  _drawGridFloor(ctx, w, h, t) {
    ctx.save();

    const horizonY = h * 0.15;
    const bottomY = h * GRID_Y_RATIO;
    const vanishX = w / 2;

    // 水平线（从远到近，间距越来越大模拟透视）
    const numHLines = 30;
    for (let i = 0; i <= numHLines; i++) {
      const ratio = i / numHLines;
      const y = lerp(horizonY, bottomY, ratio * ratio); // 二次曲线加速
      const brightness = ratio * 0.3;
      ctx.strokeStyle = hexToRgba(COLORS.gridBright, brightness);
      ctx.lineWidth = ratio < 0.3 ? 0.5 : 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // 垂直线（从灭点向两侧发散）
    const numVLines = 24;
    for (let i = -numVLines; i <= numVLines; i++) {
      const frac = i / numVLines;
      const spread = frac * w * 0.8;
      ctx.strokeStyle = hexToRgba(COLORS.grid, 0.15 * (1 - Math.abs(frac) * 0.7));
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(vanishX, horizonY);
      ctx.lineTo(vanishX + spread, bottomY + 30);
      ctx.stroke();
    }

    // 地面渐变覆盖（从下往上渐隐）
    const groundGrad = ctx.createLinearGradient(0, bottomY - 40, 0, bottomY);
    groundGrad.addColorStop(0, 'rgba(6,14,28,0)');
    groundGrad.addColorStop(1, 'rgba(6,14,28,0.6)');
    ctx.fillStyle = groundGrad;
    ctx.fillRect(0, bottomY - 40, w, 50);

    ctx.restore();
  }

  // --- 粒子 ---

  _drawParticles(ctx, w, h, t) {
    ctx.save();
    this._particles.forEach(p => {
      p.y -= p.speed;
      p.x += p.drift + Math.sin(t * 0.5 + p.phase) * 0.00005;
      if (p.y < -0.05) { p.y = 1.05; p.x = Math.random(); }
      if (p.x < -0.05) p.x = 1.05;
      if (p.x > 1.05) p.x = -0.05;

      const px = p.x * w;
      const py = p.y * h;
      const flicker = 0.4 + 0.6 * Math.sin(t * 1.5 + p.phase);
      const alpha = p.alpha * flicker;
      const depthScale = 0.3 + p.z * 0.7;
      const size = p.size * depthScale;

      // 发光粒子
      const glow = ctx.createRadialGradient(px, py, 0, px, py, size * 3);
      glow.addColorStop(0, hexToRgba(COLORS.particle, alpha * 0.5));
      glow.addColorStop(1, hexToRgba(COLORS.particle, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(px - size * 3, py - size * 3, size * 6, size * 6);

      ctx.globalAlpha = alpha;
      ctx.fillStyle = COLORS.particle;
      ctx.beginPath();
      ctx.arc(px, py, size, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
  }

  // --- 3D航段块 ---

  _drawSegment3D(ctx, seg, isHovered, isAdjacent, transT) {
    if (seg.polygon.length < 3) return;

    const poly = seg.polygon;
    const isWarning = seg.type === 'warning';
    const hoverOffset = isHovered ? -18 * this._hoverProgress : 0;
    const adjacentDim = isAdjacent ? 0.4 : 1;

    ctx.save();
    ctx.globalAlpha = adjacentDim * transT;

    // 计算多边形平均Y（用于侧面高度）
    let avgY = 0;
    poly.forEach(p => avgY += p.sy);
    avgY /= poly.length;

    const blockH = BLOCK_HEIGHT * (seg.center?.scale || 0.5);

    // === 侧面（模拟深度） ===
    // 找到多边形中Y最大（最靠近底部）的点，它们有侧面
    const sideColor = isWarning ? 'rgba(80,20,20,0.7)' : COLORS.blockSide;

    // 底面边（从左到右遍历下边缘，画侧面）
    ctx.fillStyle = sideColor;
    ctx.beginPath();
    let bottomPts = [];
    // 找到Y值最大的边缘点（y最大=最靠近观察者=底部）
    for (let i = 0; i < poly.length; i++) {
      bottomPts.push({ idx: i, y: poly[i].sy });
    }
    bottomPts.sort((a, b) => b.y - a.y);
    // 选取Y值最大的前40%的点画侧面
    const sideCount = Math.max(2, Math.ceil(poly.length * 0.4));
    const sideIndices = new Set(bottomPts.slice(0, sideCount).map(p => p.idx));

    // 简化：画整个多边形底部侧面
    if (blockH > 1) {
      ctx.beginPath();
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i];
        if (i === 0) ctx.moveTo(p.sx, p.sy + hoverOffset + blockH);
        else ctx.lineTo(p.sx, p.sy + hoverOffset + blockH);
      }
      // 闭合回顶面底部边缘
      for (let i = poly.length - 1; i >= 0; i--) {
        ctx.lineTo(poly[i].sx, poly[i].sy + hoverOffset);
      }
      ctx.closePath();
      ctx.fillStyle = sideColor;
      ctx.fill();
    }

    // === 悬停阴影 ===
    if (isHovered && this._hoverProgress > 0.1) {
      ctx.save();
      ctx.globalAlpha = 0.5 * this._hoverProgress;
      ctx.filter = 'blur(15px)';
      ctx.beginPath();
      for (let i = 0; i < poly.length; i++) {
        if (i === 0) ctx.moveTo(poly[i].sx, poly[i].sy + blockH + 8);
        else ctx.lineTo(poly[i].sx, poly[i].sy + blockH + 8);
      }
      ctx.closePath();
      ctx.fillStyle = isWarning ? 'rgba(255,0,0,0.3)' : 'rgba(0,212,255,0.3)';
      ctx.fill();
      ctx.filter = 'none';
      ctx.restore();
    }

    // === 顶面填充 ===
    ctx.beginPath();
    ctx.moveTo(poly[0].sx, poly[0].sy + hoverOffset);
    for (let i = 1; i < poly.length; i++) {
      ctx.lineTo(poly[i].sx, poly[i].sy + hoverOffset);
    }
    ctx.closePath();

    if (isWarning) {
      const alpha = lerp(0.1, 0.25, this._hoverProgress * (isHovered ? 1 : 0));
      ctx.fillStyle = hexToRgba('#ff4444', alpha);
    } else {
      const riskColor = riskScoreToColor(seg.risk);
      const alpha = lerp(0.15, 0.35, this._hoverProgress * (isHovered ? 1 : 0));
      ctx.fillStyle = hexToRgba(riskColor, alpha);
    }
    ctx.fill();

    // === 发光边框 ===
    const borderColor = isWarning ? COLORS.warning : (isHovered ? COLORS.accent : COLORS.border);
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = isHovered ? 2.5 : 1;

    if (isHovered && this._hoverProgress > 0.1) {
      ctx.shadowColor = isWarning ? COLORS.warning : COLORS.accent;
      ctx.shadowBlur = 25 * this._hoverProgress;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // === 悬停流光 ===
    if (isHovered && this._hoverProgress > 0.2) {
      this._drawSegmentFlowLight(ctx, poly, hoverOffset);
    }

    // === 航段名称标签 ===
    if (seg.center) {
      const labelAlpha = isHovered ? 1 : 0.55;
      ctx.globalAlpha = labelAlpha * adjacentDim * transT;

      // 标签背景卡片
      const name = seg.name;
      ctx.font = `${isHovered ? 'bold ' : ''}${Math.max(10, 12 * (seg.center.scale || 0.5))}px ${FONT_FAMILY}`;
      const tw = ctx.measureText(name).width;
      const padX = 8, padY = 4;
      const lx = seg.center.sx - tw / 2 - padX;
      const ly = seg.center.sy + hoverOffset - 10 - padY;

      ctx.fillStyle = 'rgba(6,14,28,0.75)';
      roundRectPath(ctx, lx, ly, tw + padX * 2, 20, 4);
      ctx.fill();

      if (isHovered) {
        ctx.strokeStyle = hexToRgba(COLORS.accent, 0.5);
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      ctx.fillStyle = isHovered ? '#ffffff' : (isWarning ? '#ff8888' : '#a0c0e0');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(name, seg.center.sx, seg.center.sy + hoverOffset - 10);
    }

    ctx.restore();
  }

  _drawSegmentFlowLight(ctx, poly, hoverOffset) {
    const t = this._time;
    const scanPos = (t * 0.3) % 1;
    const totalLen = poly.length;
    const scanIdx = Math.floor(scanPos * totalLen);
    const sx = poly[scanIdx].sx;
    const sy = poly[scanIdx].sy + hoverOffset;

    ctx.save();
    const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, 30);
    glow.addColorStop(0, 'rgba(0,212,255,0.6)');
    glow.addColorStop(0.4, 'rgba(0,212,255,0.15)');
    glow.addColorStop(1, 'rgba(0,212,255,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(sx - 30, sy - 30, 60, 60);
    ctx.restore();
  }

  // --- 边界线（霓虹发光） ---

  _drawBoundaryLines(ctx, transT) {
    if (!this.channelData) return;
    ctx.save();
    ctx.globalAlpha = transT;

    const channels = [
      { key: 'south_channel_lower' },
      { key: 'south_channel_upper' },
      { key: 'south_branch' }
    ];
    channels.forEach(ch => {
      const data = this.channelData[ch.key];
      if (!data) return;
      if (data.north_boundary) this._drawNeonLine(ctx, data.north_boundary, BOUNDARY_COLORS.main, 1.5);
      if (data.south_boundary) this._drawNeonLine(ctx, data.south_boundary, BOUNDARY_COLORS.main, 1.5);
    });

    ['jiuduansha_warning', 'yuanyuansha_warning'].forEach(key => {
      const data = this.channelData[key];
      if (data) this._drawNeonLine(ctx, data, BOUNDARY_COLORS.warning, 1.2);
    });

    ctx.restore();
  }

  /**
   * 霓虹发光线条：双层（宽模糊底色 + 窄明亮主线）+ 流光
   */
  _drawNeonLine(ctx, coords, color, lineWidth) {
    if (coords.length < 2) return;
    const projected = coords.map(p => this._projectPoint(p[0], p[1]));

    // 外发光层（宽模糊底色）
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth + 6;
    ctx.globalAlpha = 0.12;
    ctx.shadowColor = color;
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.moveTo(projected[0].sx, projected[0].sy);
    for (let i = 1; i < projected.length; i++) ctx.lineTo(projected[i].sx, projected[i].sy);
    ctx.stroke();
    ctx.restore();

    // 中间发光层
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth + 2;
    ctx.globalAlpha = 0.25;
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(projected[0].sx, projected[0].sy);
    for (let i = 1; i < projected.length; i++) ctx.lineTo(projected[i].sx, projected[i].sy);
    ctx.stroke();
    ctx.restore();

    // 主线（窄明亮）
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.moveTo(projected[0].sx, projected[0].sy);
    for (let i = 1; i < projected.length; i++) ctx.lineTo(projected[i].sx, projected[i].sy);
    ctx.stroke();
    ctx.restore();

    // 流光扫描
    const scanPos = (this._time * 0.12) % 1;
    const scanIdx = Math.floor(scanPos * (projected.length - 1));
    const scanFrac = scanPos * (projected.length - 1) - scanIdx;
    if (scanIdx < projected.length - 1) {
      const sx = lerp(projected[scanIdx].sx, projected[scanIdx + 1].sx, scanFrac);
      const sy = lerp(projected[scanIdx].sy, projected[scanIdx + 1].sy, scanFrac);
      ctx.save();
      const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, 35);
      glow.addColorStop(0, hexToRgba(color, 0.8));
      glow.addColorStop(0.4, hexToRgba(color, 0.2));
      glow.addColorStop(1, hexToRgba(color, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(sx - 35, sy - 35, 70, 70);
      ctx.restore();
    }
  }

  // --- 航道中线 ---

  _drawCenterlines(ctx, transT) {
    if (!this.channelData) return;
    ctx.save();
    ctx.globalAlpha = transT * 0.5;

    const channels = ['south_channel_lower', 'south_channel_upper', 'south_branch'];
    channels.forEach(key => {
      const data = this.channelData[key];
      if (!data || !data.centerline) return;
      const projected = data.centerline.map(p => this._projectPoint(p[0], p[1]));
      ctx.beginPath();
      ctx.moveTo(projected[0].sx, projected[0].sy);
      for (let i = 1; i < projected.length; i++) ctx.lineTo(projected[i].sx, projected[i].sy);
      ctx.strokeStyle = COLORS.accent;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
    });

    ctx.restore();
  }

  // --- 船舶 ---

  _drawShip(ctx, ship, transT) {
    if (!ship.projected) return;
    const p = ship.projected;
    const size = Math.max(6, 12 * p.scale);
    const color = SHIP_COLORS[ship.type] || SHIP_COLORS.cargo;
    const heading = (ship.heading || 0) * Math.PI / 180;
    const isHovered = this._hoveredShipId === ship.name;

    ctx.save();
    ctx.globalAlpha = transT;
    ctx.translate(p.sx, p.sy);

    // 光晕
    if (isHovered) {
      const glowR = size + 12;
      const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, glowR);
      glow.addColorStop(0, hexToRgba(color, 0.4));
      glow.addColorStop(1, hexToRgba(color, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(-glowR, -glowR, glowR * 2, glowR * 2);
    }

    // 三角标记
    const drawSize = isHovered ? size * 1.4 : size;
    ctx.rotate(-heading + Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(0, -drawSize);
    ctx.lineTo(-drawSize * 0.6, drawSize * 0.5);
    ctx.lineTo(drawSize * 0.6, drawSize * 0.5);
    ctx.closePath();

    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = isHovered ? 18 : 10;
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 0.5;
    ctx.globalAlpha = (isHovered ? 0.9 : 0.5) * transT;
    ctx.stroke();
    ctx.restore();

    // 航向矢量线
    ctx.save();
    ctx.globalAlpha = 0.4 * transT;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    const vecLen = drawSize * 2;
    const endX = p.sx + Math.sin(-heading + Math.PI / 2) * (-vecLen);
    const endY = p.sy - Math.cos(-heading + Math.PI / 2) * (-vecLen);
    ctx.beginPath();
    ctx.moveTo(p.sx, p.sy);
    ctx.lineTo(endX, endY);
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // 船名标签
    if (isHovered || p.scale > 0.35) {
      ctx.save();
      ctx.globalAlpha = (isHovered ? 1 : 0.55) * transT;
      ctx.font = `${isHovered ? 'bold ' : ''}${Math.max(9, (isHovered ? 12 : 10) * p.scale)}px ${FONT_FAMILY}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = isHovered ? '#ffffff' : '#c0d8e8';
      ctx.fillText(ship.name || '', p.sx, p.sy + drawSize + 14);
      ctx.restore();
    }
  }

  // --- 悬停tooltip ---

  _drawTooltip(ctx, seg) {
    const mx = this._mouseX, my = this._mouseY;
    const segShips = this.ships.filter(s => s.segment === seg.id);
    const riskText = riskScoreToText(seg.risk);
    const riskColor = riskScoreToColor(seg.risk);

    const lines = [
      seg.name,
      `风险等级: ${riskText}`,
      `船舶数量: ${segShips.length}艘`
    ];

    ctx.save();
    ctx.font = `12px ${FONT_FAMILY}`;
    const lineHeight = 22;
    const padding = 12;
    const maxTextWidth = Math.max(...lines.map(l => ctx.measureText(l).width));
    const tooltipW = maxTextWidth + padding * 2;
    const tooltipH = lines.length * lineHeight + padding * 2;

    let tx = mx + 18;
    let ty = my - tooltipH - 8;
    if (tx + tooltipW > this.width - 10) tx = mx - tooltipW - 18;
    if (ty < 10) ty = my + 18;

    // 发光阴影
    ctx.shadowColor = COLORS.accent;
    ctx.shadowBlur = 15;
    ctx.fillStyle = 'rgba(6,14,28,0.94)';
    roundRectPath(ctx, tx, ty, tooltipW, tooltipH, 8);
    ctx.fill();
    ctx.shadowBlur = 0;

    // 边框
    ctx.strokeStyle = COLORS.accent;
    ctx.lineWidth = 1;
    ctx.stroke();

    // 左侧色条
    ctx.fillStyle = riskColor;
    roundRectPath(ctx, tx, ty, 3, tooltipH, 2);
    ctx.fill();

    // 文字
    ctx.textBaseline = 'top';
    lines.forEach((line, i) => {
      const ly = ty + padding + i * lineHeight;
      if (i === 0) {
        ctx.fillStyle = COLORS.accent;
        ctx.font = `bold 13px ${FONT_FAMILY}`;
      } else if (i === 1) {
        ctx.fillStyle = riskColor;
        ctx.font = `12px ${FONT_FAMILY}`;
      } else {
        ctx.fillStyle = '#a0b8d0';
        ctx.font = `12px ${FONT_FAMILY}`;
      }
      ctx.fillText(line, tx + padding + 4, ly);
    });

    ctx.restore();
  }

  // --- HUD标题 ---

  _drawHUD(ctx, w, h, t) {
    ctx.save();

    // 顶部装饰线
    const topBarH = 56;
    const topGrad = ctx.createLinearGradient(0, 0, 0, topBarH);
    topGrad.addColorStop(0, 'rgba(6,14,28,0.9)');
    topGrad.addColorStop(1, 'rgba(6,14,28,0)');
    ctx.fillStyle = topGrad;
    ctx.fillRect(0, 0, w, topBarH);

    // 底部边线
    ctx.strokeStyle = hexToRgba(COLORS.accent, 0.3);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, topBarH);
    ctx.lineTo(w, topBarH);
    ctx.stroke();

    // 左侧装饰角
    ctx.strokeStyle = COLORS.accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(8, 16);
    ctx.lineTo(8, 8);
    ctx.lineTo(30, 8);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(w - 8, 16);
    ctx.lineTo(w - 8, 8);
    ctx.lineTo(w - 30, 8);
    ctx.stroke();

    // 标题
    ctx.fillStyle = COLORS.accent;
    ctx.font = `bold 18px ${FONT_FAMILY}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.shadowColor = COLORS.accent;
    ctx.shadowBlur = 12;
    ctx.fillText('航道全景态势', 24, 16);
    ctx.shadowBlur = 0;

    // 副标题
    ctx.fillStyle = COLORS.textDim;
    ctx.font = `11px ${FONT_FAMILY}`;
    ctx.fillText('长江口南槽航道 - 搁浅防范与应急处置', 24, 40);

    // 扫描线动画（顶部装饰）
    const scanX = ((t * 80) % (w + 200)) - 100;
    const scanGrad = ctx.createLinearGradient(scanX - 60, 0, scanX + 60, 0);
    scanGrad.addColorStop(0, 'rgba(0,212,255,0)');
    scanGrad.addColorStop(0.5, 'rgba(0,212,255,0.08)');
    scanGrad.addColorStop(1, 'rgba(0,212,255,0)');
    ctx.fillStyle = scanGrad;
    ctx.fillRect(0, 0, w, 3);

    // 图例
    const legendX = w - 190;
    const legendY = 16;
    ctx.font = `10px ${FONT_FAMILY}`;
    ctx.textAlign = 'left';

    const legends = [
      { color: BOUNDARY_COLORS.main, label: '航道边界' },
      { color: BOUNDARY_COLORS.warning, label: '警戒区' },
      { color: SHIP_COLORS.construction, label: '施工船' },
      { color: SHIP_COLORS.cargo, label: '通航船' },
      { color: RISK_COLORS.low, label: '正常' },
      { color: RISK_COLORS.medium, label: '中风险' },
      { color: RISK_COLORS.high, label: '高风险' }
    ];

    legends.forEach((leg, i) => {
      const ly = legendY + i * 18;
      ctx.fillStyle = leg.color;
      ctx.fillRect(legendX, ly + 2, 12, 10);
      ctx.fillStyle = COLORS.textDim;
      ctx.fillText(leg.label, legendX + 18, ly + 1);
    });

    // 操作提示
    ctx.fillStyle = hexToRgba(COLORS.textDim, 0.6);
    ctx.font = `10px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.fillText('左键拖拽旋转 | 右键平移 | 滚轮缩放', w / 2, h - 14);

    // 右下角时间戳
    const now = new Date();
    const timeStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
    ctx.textAlign = 'right';
    ctx.fillStyle = hexToRgba(COLORS.accent, 0.4);
    ctx.fillText(timeStr, w - 16, h - 14);

    ctx.restore();
  }

  // ==================== 详情视图 ====================

  _renderDetail(ctx, w, h) {
    const transT = this._transitioning ? easeInOutCubic(this._transitionProgress) : 1;

    this._drawBackground(ctx, w, h, this._time);

    const seg = this.segments.find(s => s.id === this._selectedSegId);
    const segShips = this.ships.filter(s => s.segment === this._selectedSegId);
    const segRisk = this.risks[this._selectedSegId] || 0;

    if (!seg) { this._backToPanorama(); return; }
    if (this._selectedShipIdx >= segShips.length) this._selectedShipIdx = 0;

    const margin = 20;
    const topBarH = 50;
    const contentY = topBarH + margin;
    const contentH = h - contentY - margin;

    this._drawDetailTopBar(ctx, w, seg, segShips, margin, topBarH);

    if (segShips.length > 0) {
      const ship = segShips[this._selectedShipIdx];
      const leftW = w * 0.55;
      const gap = 10;

      this._drawCrossSection(ctx, margin, contentY, leftW, contentH, seg, ship);

      const rightX = margin + leftW + gap;
      const rightW = w - rightX - margin;
      const shipListH = contentH;

      if (segShips.length > 1) {
        this._drawShipList(ctx, rightX, contentY, rightW, shipListH, segShips);
      }
    } else {
      this._drawSegmentOverview(ctx, margin, contentY, w - margin * 2, contentH, seg, segRisk);
    }
  }

  // --- 详情顶栏 ---

  _drawDetailTopBar(ctx, w, seg, segShips, margin, topBarH) {
    ctx.save();

    ctx.fillStyle = 'rgba(6,14,28,0.85)';
    ctx.fillRect(0, 0, w, topBarH + margin);
    ctx.strokeStyle = hexToRgba(COLORS.accent, 0.3);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, topBarH + margin);
    ctx.lineTo(w, topBarH + margin);
    ctx.stroke();

    ctx.fillStyle = COLORS.accent;
    ctx.font = `bold 16px ${FONT_FAMILY}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${seg.name} - 航段详情`, margin + 10, topBarH / 2);

    this._drawButton(ctx, margin + 10, topBarH + 4, 100, 30, '返回全景', () => this._backToPanorama());
    this._drawButton(ctx, w - margin - 130, topBarH + 4, 120, 30, '进入3D剖视', () => this._enter3DView());

    if (segShips.length > 1) {
      const btnX = margin + 120, btnW = 130, btnY = topBarH + 4, btnH = 30;
      ctx.fillStyle = 'rgba(0,212,255,0.1)';
      ctx.strokeStyle = COLORS.accent;
      ctx.lineWidth = 1;
      roundRectPath(ctx, btnX, btnY, btnW, btnH, 4);
      ctx.fill();
      ctx.stroke();

      const currentShip = segShips[this._selectedShipIdx] || segShips[0];
      ctx.fillStyle = COLORS.accent;
      ctx.font = `12px ${FONT_FAMILY}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${currentShip.name || '船舶'} (${this._selectedShipIdx + 1}/${segShips.length})`, btnX + btnW / 2, btnY + btnH / 2);

      ctx.fillStyle = COLORS.textDim;
      ctx.font = '16px sans-serif';
      ctx.fillText('\u25C0', btnX + 12, btnY + btnH / 2);
      ctx.fillText('\u25B6', btnX + btnW - 12, btnY + btnH / 2);

      this._buttons.push({
        x: btnX, y: btnY, w: btnW / 2, h: btnH,
        shipIdx: (this._selectedShipIdx - 1 + segShips.length) % segShips.length,
        action: () => { this._selectedShipIdx = (this._selectedShipIdx - 1 + segShips.length) % segShips.length; }
      });
      this._buttons.push({
        x: btnX + btnW / 2, y: btnY, w: btnW / 2, h: btnH,
        shipIdx: (this._selectedShipIdx + 1) % segShips.length,
        action: () => { this._selectedShipIdx = (this._selectedShipIdx + 1) % segShips.length; }
      });
    }

    ctx.restore();
  }

  // --- 通用按钮 ---

  _drawButton(ctx, x, y, bw, bh, text, action) {
    ctx.save();
    const hovered = this._mouseX >= x && this._mouseX <= x + bw &&
                    this._mouseY >= y && this._mouseY <= y + bh;
    ctx.fillStyle = hovered ? 'rgba(0,212,255,0.2)' : 'rgba(0,212,255,0.1)';
    ctx.strokeStyle = COLORS.accent;
    ctx.lineWidth = 1;
    roundRectPath(ctx, x, y, bw, bh, 4);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = COLORS.accent;
    ctx.font = `12px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + bw / 2, y + bh / 2);
    ctx.restore();

    this._buttons.push({ x, y, w: bw, h: bh, action });
  }

  // --- 面板背景 ---

  _drawPanelBg(ctx, x, y, w, h, title) {
    ctx.save();
    ctx.fillStyle = 'rgba(6,14,28,0.88)';
    ctx.strokeStyle = hexToRgba(COLORS.accent, 0.25);
    ctx.lineWidth = 1;
    roundRectPath(ctx, x, y, w, h, 6);
    ctx.fill();
    ctx.stroke();

    if (title) {
      ctx.fillStyle = COLORS.accent;
      ctx.font = `bold 12px ${FONT_FAMILY}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(title, x + 10, y + 8);

      ctx.strokeStyle = hexToRgba(COLORS.accent, 0.25);
      ctx.beginPath();
      ctx.moveTo(x + 10, y + 26);
      ctx.lineTo(x + w - 10, y + 26);
      ctx.stroke();
    }
    ctx.restore();
  }

  // --- 航道横截面 ---

  _drawCrossSection(ctx, x, y, w, h, seg, ship) {
    ctx.save();
    this._drawPanelBg(ctx, x, y, w, h, '航道横截面');

    const innerX = x + 10, innerY = y + 35;
    const innerW = w - 20, innerH = h - 50;
    const axisX = innerX + 30, axisY = innerY + innerH - 20;
    const plotW = innerW - 50, plotH = innerH - 40;

    ctx.strokeStyle = hexToRgba(COLORS.accent, 0.3);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(axisX, innerY); ctx.lineTo(axisX, axisY); ctx.lineTo(axisX + plotW, axisY);
    ctx.stroke();

    ctx.fillStyle = COLORS.textDim;
    ctx.font = `10px ${FONT_FAMILY}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const maxDepth = 12;
    for (let d = 0; d <= maxDepth; d += 2) {
      const py = axisY - (d / maxDepth) * plotH;
      ctx.fillText(`${d}m`, axisX - 5, py);
      ctx.strokeStyle = hexToRgba(COLORS.accent, 0.1);
      ctx.beginPath(); ctx.moveTo(axisX, py); ctx.lineTo(axisX + plotW, py); ctx.stroke();
    }

    const halfW = plotW / 2;
    const centerDepth = 8 + 1;
    const edgeDepth = 2;

    ctx.beginPath();
    ctx.moveTo(axisX, axisY);
    ctx.lineTo(axisX + halfW * 0.2, axisY);
    ctx.quadraticCurveTo(axisX + halfW * 0.3, axisY - (edgeDepth / maxDepth) * plotH,
                          axisX + halfW * 0.35, axisY - (centerDepth * 0.6 / maxDepth) * plotH);
    ctx.quadraticCurveTo(axisX + halfW * 0.5, axisY - (centerDepth / maxDepth) * plotH,
                          axisX + halfW * 0.65, axisY - (centerDepth * 0.6 / maxDepth) * plotH);
    ctx.quadraticCurveTo(axisX + halfW * 0.7, axisY - (edgeDepth / maxDepth) * plotH,
                          axisX + halfW * 0.8, axisY);
    ctx.lineTo(axisX + plotW, axisY);
    ctx.lineTo(axisX, axisY);
    ctx.closePath();

    const waterGrad = ctx.createLinearGradient(axisX, axisY, axisX, axisY - plotH);
    waterGrad.addColorStop(0, 'rgba(0,80,120,0.4)');
    waterGrad.addColorStop(1, 'rgba(0,40,80,0.6)');
    ctx.fillStyle = waterGrad;
    ctx.fill();

    ctx.strokeStyle = COLORS.accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(axisX, axisY);
    ctx.lineTo(axisX + halfW * 0.2, axisY);
    ctx.quadraticCurveTo(axisX + halfW * 0.3, axisY - (edgeDepth / maxDepth) * plotH,
                          axisX + halfW * 0.35, axisY - (centerDepth * 0.6 / maxDepth) * plotH);
    ctx.quadraticCurveTo(axisX + halfW * 0.5, axisY - (centerDepth / maxDepth) * plotH,
                          axisX + halfW * 0.65, axisY - (centerDepth * 0.6 / maxDepth) * plotH);
    ctx.quadraticCurveTo(axisX + halfW * 0.7, axisY - (edgeDepth / maxDepth) * plotH,
                          axisX + halfW * 0.8, axisY);
    ctx.lineTo(axisX + plotW, axisY);
    ctx.stroke();

    ctx.strokeStyle = hexToRgba(COLORS.accent, 0.5);
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(axisX, axisY); ctx.lineTo(axisX + plotW, axisY); ctx.stroke();
    ctx.setLineDash([]);

    const draft = ship.draft || (ship.length > 100 ? 6 : 4);
    const draftY = axisY - (draft / maxDepth) * plotH;
    const channelWidthM = 400;
    const shipW = (ship.width || 20) / channelWidthM * plotW;
    const shipX = axisX + halfW - shipW / 2;

    ctx.fillStyle = 'rgba(255,107,53,0.4)';
    ctx.strokeStyle = SHIP_COLORS.construction;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(shipX, axisY); ctx.lineTo(shipX, draftY); ctx.lineTo(shipX + shipW, draftY); ctx.lineTo(shipX + shipW, axisY);
    ctx.closePath(); ctx.fill(); ctx.stroke();

    ctx.fillStyle = '#ff6b35';
    ctx.font = `bold 10px ${FONT_FAMILY}`;
    ctx.textAlign = 'left';
    ctx.fillText(`吃水 ${draft.toFixed(1)}m`, shipX + shipW + 5, draftY + 3);

    const ukc = centerDepth - draft;
    if (ukc > 0) {
      const ukcY = (draftY + (axisY - (centerDepth / maxDepth) * plotH)) / 2;
      ctx.strokeStyle = ukc < 1 ? '#ff4444' : ukc < 2 ? '#ffaa00' : '#44ff44';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(shipX - 5, draftY); ctx.lineTo(shipX - 5, axisY - (centerDepth / maxDepth) * plotH); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.font = `10px ${FONT_FAMILY}`;
      ctx.textAlign = 'right';
      ctx.fillText(`UKC ${ukc.toFixed(1)}m`, shipX - 8, ukcY + 3);
    }

    ctx.fillStyle = COLORS.textDim;
    ctx.font = `10px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.fillText('航道横截面', axisX + plotW / 2, axisY + 15);
    ctx.restore();
  }


  // --- 船舶列表 ---

  _drawShipList(ctx, x, y, w, h, segShips) {
    ctx.save();
    this._drawPanelBg(ctx, x, y, w, h, '船舶列表');

    const listY = y + 32;
    const rowH = Math.min(28, (h - 36) / segShips.length);

    segShips.forEach((ship, i) => {
      const ry = listY + i * rowH;
      if (ry + rowH > y + h) return;

      const isSelected = i === this._selectedShipIdx;
      const color = SHIP_COLORS[ship.type] || SHIP_COLORS.cargo;

      if (isSelected) {
        ctx.fillStyle = hexToRgba(COLORS.accent, 0.15);
        ctx.fillRect(x + 5, ry, w - 10, rowH);
      }

      // 色块
      ctx.fillStyle = color;
      ctx.fillRect(x + 10, ry + 6, 8, 8);

      // 名称
      ctx.fillStyle = isSelected ? '#ffffff' : COLORS.text;
      ctx.font = `${isSelected ? 'bold ' : ''}11px ${FONT_FAMILY}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(ship.name || `船舶${i + 1}`, x + 24, ry + rowH / 2);

      // 类型
      ctx.fillStyle = COLORS.textDim;
      ctx.font = `10px ${FONT_FAMILY}`;
      ctx.textAlign = 'right';
      ctx.fillText(ship.type === 'construction' ? '施工船' : '通航船', x + w - 10, ry + rowH / 2);

      // 注册点击
      this._buttons.push({
        x: x + 5, y: ry, w: w - 10, h: rowH,
        shipIdx: i,
        action: () => { this._selectedShipIdx = i; }
      });
    });

    ctx.restore();
  }

  // --- 航段概览（无船舶时） ---

  _drawSegmentOverview(ctx, x, y, w, h, seg, segRisk) {
    ctx.save();
    this._drawPanelBg(ctx, x, y, w, h, `${seg.name} - 航段概览`);

    const cx = x + w / 2, cy = y + h / 2;

    ctx.fillStyle = COLORS.accent;
    ctx.font = `bold 14px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.fillText(seg.name, cx, cy - 30);

    ctx.fillStyle = riskScoreToColor(segRisk);
    ctx.font = `bold 24px ${FONT_FAMILY}`;
    ctx.fillText(`风险: ${riskScoreToText(segRisk)}`, cx, cy + 5);

    ctx.fillStyle = COLORS.textDim;
    ctx.font = `12px ${FONT_FAMILY}`;
    ctx.fillText(`评分: ${(segRisk * 100).toFixed(0)}%`, cx, cy + 30);

    ctx.fillStyle = hexToRgba(COLORS.accent, 0.15);
    ctx.font = `12px ${FONT_FAMILY}`;
    ctx.fillText('当前航段无船舶数据', cx, cy + 60);

    ctx.restore();
  }

}
