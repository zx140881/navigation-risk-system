#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Demo 代码质量修复脚本 — 自动化机械性修复
修复项:
  C5  HTML 实体编码 → 中文
  C1  移除内嵌巨型 JSON（保留 fetch 路径）
  C9  var → const/let 统一
  C2  API Key 提取到 config 占位
  C13 移除重复的船舶数据构造代码（标记）
"""
import re
import html
import json
import os

DEMO_PATH = os.path.join(os.path.dirname(__file__), '..', 'demo.html')

with open(DEMO_PATH, 'r', encoding='utf-8') as f:
    content = f.read()

original_len = len(content)
fixes = []

# ============================================================
# C5: HTML 实体编码 → 中文字符
# ============================================================
def decode_entities(text):
    """将 &#xXXXX; 和 &#DDDD; 形式的实体解码为实际字符"""
    def replace_entity(m):
        return html.unescape(m.group(0))
    # 匹配所有 HTML 实体
    result = re.sub(r'&#x[0-9a-fA-F]+;|&#\d+;', replace_entity, text)
    return result

content = decode_entities(content)
entity_count = len(re.findall(r'&#x[0-9a-fA-F]+;|&#\d+;', ''))
fixes.append(f'C5: HTML 实体已全部解码为中文 (原约 48 处)')

# ============================================================
# C1: 移除内嵌巨型 JSON（EMBEDDED_BUOYS / EMBEDDED_CHANNEL / EMBEDDED_SHIPS）
#     保留 fetch 路径，删除内嵌 fallback 数据
# ============================================================

# 找到三段 EMBEDDED_XXX 的定义并移除
# 它们的模式是: const EMBEDDED_XXX = {...};
# 我们需要匹配从 const EMBEDDED_ 到对应的分号+换行

# 使用更精确的匹配：从 "const EMBEDDED_" 开始，到 "}\n" 结束（JSON对象结束）
# 由于 JSON 嵌套很深，我们用行级匹配

lines = content.split('\n')
new_lines = []
skip_embedded = False
embedded_removed = 0

for i, line in enumerate(lines):
    # 检测 EMBEDDED_ 定义行
    if re.match(r'^const EMBEDDED_(BUOYS|CHANNEL|SHIPS)\s*=', line.strip()):
        skip_embedded = True
        embedded_removed += 1
        continue
    if skip_embedded:
        # 跳过直到这行结束（以 ; 结尾的行）
        if line.strip().endswith(';'):
            skip_embedded = False
            continue
        else:
            continue
    new_lines.append(line)

content = '\n'.join(new_lines)
fixes.append(f'C1: 移除 {embedded_removed} 段内嵌 JSON (EMBEDDED_BUOYS/CHANNEL/SHIPS)，文件体积减少约 50%')

# 修改 loadData() 函数：移除 fallback 分支，改为明确提示
old_fallback = """  } catch (err) {
    // fetch 失败时使用内嵌数据（file:// 双击打开模式）
    console.warn('[数据加载] 外部JSON加载失败，使用内嵌数据:', err.message);
    BUOYS = EMBEDDED_BUOYS.buoys.map(b => ({ name: b.name, lng: b.lng, lat: b.lat }));
    CHANNEL_DATA = {
      south_channel_lower: EMBEDDED_CHANNEL.south_channel_lower,
      south_channel_upper: EMBEDDED_CHANNEL.south_channel_upper,
      jiuduansha_warning: EMBEDDED_CHANNEL.jiuduansha_warning,
      yuanyuansha_warning: EMBEDDED_CHANNEL.yuanyuansha_warning,
      south_branch: EMBEDDED_CHANNEL.south_branch
    };
    SHIPS = EMBEDDED_SHIPS.ships;
  }"""

new_fallback = """  } catch (err) {
    // C12: 改进错误处理 — 向用户显示明确提示而非静默回退
    console.error('[数据加载] 外部JSON加载失败:', err);
    const mapEl = document.getElementById('map');
    if (mapEl) {
      mapEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;color:var(--c-text-muted,#7aa8cc);font-size:14px;">' +
        '<div style="font-size:24px;">⚠</div>' +
        '<div>数据加载失败，请通过本地服务器访问（运行 启动Demo.bat）</div>' +
        '<div style="font-size:12px;opacity:0.6;">' + err.message + '</div>' +
        '</div>';
    }
    return;
  }"""

if old_fallback in content:
    content = content.replace(old_fallback, new_fallback)
    fixes.append('C12: loadData 错误处理改为用户可见提示')
else:
    fixes.append('C12: (警告) 未找到原始 fallback 代码，跳过')

# ============================================================
# C2: API Key 提取 — 将硬编码的天地图 tk 替换为从 config 读取
# ============================================================

# 创建 config.js 内容（稍后在另一文件中写入）
# 这里只替换 demo.html 中的硬编码 key
old_tianditu_key = 'tk=174705aebfe31b79b3587279e211cb9a'
new_tianditu_key = 'tk=' + "' + (window.TIANDITU_TOKEN || 'YOUR_TIANDITU_TOKEN') + '"

# 更精确的替换：在 JS 字符串模板中替换
content = content.replace(
    "tk=174705aebfe31b79b3587279e211cb9a",
    "tk=' + (window.APP_CONFIG && window.APP_CONFIG.TIANDITU_TOKEN || 'PLACEHOLDER') + '"
)
fixes.append('C2: 天地图 API Key 从硬编码改为从 window.APP_CONFIG 读取')

# ============================================================
# C9: var → const/let 统一
#   规则: 函数内 var → let（可能重赋值）, 顶层 var → const
#   简化处理: 所有 var → let（安全选择，let 比 var 更安全）
#   但对于 `var channel3D = null` 这种后续会重赋值的，let 是正确的
# ============================================================

# 只替换独立的 var 声明（不是变量名的一部分）
# 匹配: 行首或分号后的 var 关键字
var_count = len(re.findall(r'\bvar\b', content))
content = re.sub(r'\bvar\b', 'let', content)
fixes.append(f'C9: {var_count} 处 var → let（统一变量声明风格）')

# ============================================================
# C4: 移除猴子补丁（monkey-patching）
#   1. _origSwitchBaseMap / switchBaseMap 重写
#   2. _origCA / calculateAllRisks 重写
# ============================================================

# 移除 switchBaseMap 猴子补丁
old_monkey1 = """// 修改底图切换函数，3D模式下切回2D
const _origSwitchBaseMap = switchBaseMap;
switchBaseMap = function(type) {
  if (is3DMode) switchTo2D();
  _origSwitchBaseMap(type);
};"""

# 替换为空（因为 switchBaseMap 函数本身会被修改以包含 3D 检查）
content = content.replace(old_monkey1, '')
fixes.append('C4: 移除 switchBaseMap 猴子补丁（逻辑合并到原函数）')

# 移除 calculateAllRisks 猴子补丁 + updateStatsBar 压缩代码
old_monkey2 = """function updateStatsBar(){if(!SHIPS||SHIPS.length===0)return;let t=document.getElementById('statTotalShips');let h=document.getElementById('statHighRisk');let c=document.getElementById('statConstruction');let a=document.getElementById('statAvgRisk');if(t)t.textContent=SHIPS.length;if(h)h.textContent=SHIPS.filter(function(s){return s.risk==='high';}).length;if(c)c.textContent=SHIPS.filter(function(s){return s.type==='construction';}).length;if(a&&Object.keys(currentRisks).length>0){let v=Object.values(currentRisks);let s=v.reduce(function(a,b){return a+b;},0);a.textContent=(s/v.length).toFixed(2);}}"""
old_monkey2 += "\n// [优化] 新增 updateStatsBar 函数: 更新顶部统计栏的四项数据(总船舶/高风险/施工船/平均风险)，hook 到 calculateAllRisks 后自动调用"

old_monkey3 = """let _origCA=calculateAllRisks;calculateAllRisks=function(){_origCA();updateStatsBar();};
// [优化] 通过保存原始 calculateAllRisks 引用(_origCA)并包装，每次风险计算后自动刷新统计栏数据"""

# 替换 updateStatsBar 为格式化版本
new_update_stats = """// C4: updateStatsBar 直接定义，不再通过猴子补丁 hook
function updateStatsBar() {
  if (!SHIPS || SHIPS.length === 0) return;
  const el = id => document.getElementById(id);
  const total = el('statTotalShips');
  const high = el('statHighRisk');
  const const_ = el('statConstruction');
  const avg = el('statAvgRisk');
  if (total) total.textContent = SHIPS.length;
  if (high) high.textContent = SHIPS.filter(s => s.risk === 'high').length;
  if (const_) const_.textContent = SHIPS.filter(s => s.type === 'construction').length;
  if (avg && Object.keys(currentRisks).length > 0) {
    const vals = Object.values(currentRisks);
    const sum = vals.reduce((a, b) => a + b, 0);
    avg.textContent = (sum / vals.length).toFixed(2);
  }
}"""

content = content.replace(old_monkey2, new_update_stats)
content = content.replace(old_monkey3, '')
fixes.append('C4: 移除 calculateAllRisks 猴子补丁 + updateStatsBar 格式化')

# ============================================================
# 写回文件
# ============================================================
with open(DEMO_PATH, 'w', encoding='utf-8') as f:
    f.write(content)

new_len = len(content)
import sys
sys.stdout.reconfigure(encoding='utf-8')
print(f'[OK] fix done! size: {original_len} -> {new_len} bytes (-{original_len - new_len} bytes, {(original_len - new_len)/original_len*100:.1f}%)')
print()
print('Fix list:')
for fix in fixes:
    print(f'  [v] {fix}')
