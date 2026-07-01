/**
 * 应用配置文件
 * C2 修复: 将敏感信息（API Key）从源码中移出
 *
 * 使用方式:
 *   1. 将本文件中的 YOUR_TIANDITU_TOKEN 替换为真实 Token
 *   2. 在 demo.html 中通过 <script src="config.js"></script> 引入
 *   3. 切勿将真实 Token 提交到公开仓库（.gitignore 已排除 config.local.js）
 *
 * 安全建议:
 *   - 生产环境应通过后端代理转发瓦片请求，Token 不应出现在前端
 *   - 本文件仅用于本地开发/演示，Token 应定期轮换
 */
window.APP_CONFIG = {
  // 天地图 API Token（替换为你的真实 Token）
  TIANDITU_TOKEN: 'YOUR_TIANDITU_TOKEN',

  // 数据刷新间隔（毫秒）
  REFRESH_INTERVAL: 30000,

  // 风险阈值
  RISK_THRESHOLD_HIGH: 0.7,
  RISK_THRESHOLD_MEDIUM: 0.4,

  // 地图初始视角
  MAP_CENTER: [31.15, 121.95],
  MAP_ZOOM: 10,
};
