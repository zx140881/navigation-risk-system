# 多系统融合的航道水域航行动态智能风险评估系统

> 面向重大水工工程施工水域的应用 · DEMO v6.3

## 项目简介

本系统基于 **Leaflet 2D 地图 + Three.js 3D 场景** 构建，实现航道水域船舶实时态势展示、航段风险评估、3D 航道数字孪生、预测推演等功能。

## 快速开始

### 方式一：本地服务器（推荐）

```bash
# 1. 配置 API Key（编辑 config.js，替换 YOUR_TIANDITU_TOKEN）
cp config.js config.local.js  # 可选：使用本地配置覆盖

# 2. 启动服务器
python -m http.server 8888

# 3. 浏览器访问
#    http://localhost:8888/demo.html
```

或直接双击 `启动Demo.bat`（Windows）。

### 方式二：双击打开

直接双击 `demo.html` 可在 `file://` 协议下运行，但部分功能（外部数据加载）会降级。

## 项目结构

```
navigation-risk-system/
├── demo.html                 # 主页面（2D 地图 + 3D 视图入口）
├── config.js                 # 应用配置（API Key、阈值等）
├── js/
│   ├── channel3d.js          # Three.js 3D 航道模块
│   └── channel-panorama.js   # 全景态势视图模块
├── data/
│   ├── buoys.json            # 航标数据
│   ├── channel_data.json     # 航道边界数据
│   ├── ships.json            # 船舶数据
│   └── segments.json         # 航段定义
├── scripts/
│   └── fix_demo.py           # 代码质量修复脚本
├── 启动Demo.bat              # Windows 启动脚本
├── package.json              # 项目元数据
├── .eslintrc.json            # ESLint 配置
├── .prettierrc.json          # Prettier 配置
└── .gitignore
```

## 代码质量

本项目已进行系统性代码质量治理，修复内容包括：

| 编号 | 修复项 | 说明 |
|------|--------|------|
| C1 | 数据外置 | 移除内嵌 JSON，统一从 data/ 加载 |
| C2 | API Key 外置 | 天地图 Token 移至 config.js |
| C3 | 事件委托 | 统一 data-action 事件绑定 |
| C4 | 消除猴子补丁 | switchBaseMap/calculateAllRisks 逻辑合并 |
| C5 | HTML 实体还原 | 所有 `&#xXXXX;` 解码为中文 |
| C6 | 内联事件迁移 | onclick → data-action + addEventListener |
| C7 | 内联样式迁移 | 提取为 CSS 类 |
| C8 | Design Tokens | 139 处硬编码颜色 → CSS 变量 |
| C9 | var 统一 | 所有 var → let/const |
| C11 | 工程化 | ESLint + Prettier + .gitignore |
| E1 | 响应式设计 | 平板/手机断点，侧边栏抽屉化 |
| E2 | 主题切换 | 明/暗主题 + localStorage 持久化 |
| E3 | 无障碍 | aria-label、role、语义化 HTML |
| E4 | 性能优化 | CDN SRI + defer 加载 |
| E5 | 骨架屏 | 加载状态遮罩 |
| E6 | !important 削减 | 保留必要 Leaflet 覆盖 |

## 技术栈

- **地图引擎**: Leaflet 1.9.4
- **3D 引擎**: Three.js 0.160.0 (ES Module)
- **底图**: 高德地图 / 天地图 / 遥感卫星
- **数据格式**: JSON

## License

MIT
