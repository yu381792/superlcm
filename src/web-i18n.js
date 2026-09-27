// Interface language. Chinese source strings are the keys; other languages map them.
// To add a language, add a table below and an option to #langSel in web-page.js.
const LANGS = {
  // Keys that need context to disambiguate; Chinese shows the short form.
  zh: { '关闭（摘要方式）': '关闭' },
  en: {
    '关闭（摘要方式）': 'Off',
    '导入': 'Import', '早期记录': 'Legacy', '时间未知': 'Unknown time', '刚刚': 'just now', '{n} 分钟前': '{n} min ago', '{n} 小时前': '{n} h ago', '昨天': 'yesterday',
    '复制': 'Copy', '已复制': 'Copied', '请手动选中复制': 'Select and copy manually', '全部': 'All', '{n} 条': '{n} records', '摘要覆盖 {n}%': '{n}% summarized', '暂无摘要': 'No summaries',
    '还没有对话记录。': 'No conversations yet.', '接入第一个工具': 'Connect your first tool', '{n} 个对话': '{n} conversations', '摘要 · 第 {n} 层': 'Summary · level {n}', '原文': 'Original',
    '对话': 'Conversations', '内容 · {n} 处': 'Content · {n} hits', '未找到「{q}」': 'Nothing found for “{q}”', '搜索结果': 'Search results', '第 {n} 层': 'Level {n}',
    '最新 {n} 条尚未摘要': 'Latest {n} records not summarized yet', '层级越高越概括': 'Higher levels are more condensed', '最新 {n} 条尚未摘要，原文可查': 'Latest {n} records not summarized yet; originals are readable',
    '摘要生成：': 'Summaries by: ', '摘要层级': 'Summary levels', '点击色块定位到对应摘要': 'Click a band to jump to its summary', '本机没有可用的摘要生成方式。': 'No summary method is available on this computer. ', '未摘要的对话文字约 {a} 字，还不到一段摘要（{b} 字），暂不需要生成。': 'About {a} characters of conversation text are unsummarized, less than one summary segment ({b}); nothing to generate yet.', '生成摘要': 'Generate summaries', '设置分类': 'Settings sections', '新开的 Pi 对话会自动加载 SuperLcm；已打开的对话输入 {cmd} 即可加载。': 'New Pi conversations load SuperLcm automatically; in an open one, type {cmd}.', '{tool} 已信任 SuperLcm 的钩子，新开的对话即可使用。': '{tool} already trusts SuperLcm\'s hooks; new conversations will use them.', '已在终端打开 {tool}。': '{tool} is open in a terminal. ', '它会逐个询问是否允许 SuperLcm 的钩子，输入 y 允许，然后回来点「重新检查」。': 'It asks about each SuperLcm hook; type y to allow, then come back and click Check again.', '{tool} 要求你亲自确认一次新钩子。点「打开 {tool} 确认」，在弹出的界面里允许即可。': '{tool} asks you to approve new hooks once yourself. Click Open {tool} to review and allow them there.', '打开 {tool} 确认': 'Open {tool} to review', '导入：接入之前的旧对话，可以从本机记录中挑选导入。只读取你选中的对话，不会调用模型。': 'Import: pick conversations from before you connected. Only the selected conversation is read, and no model is called.', '删除对话': 'Delete conversation', '删除对话？': 'Delete this conversation?', '将从 SuperLcm 中删除它的 {n} 条原文存档和全部摘要，删除后无法恢复。': 'Its {n} archived records and all summaries will be removed from SuperLcm. This cannot be undone.', '{tool} 里的原始对话不受影响。之后这个对话即使继续，SuperLcm 也不会再自动收录；需要时可以在「接入」页重新导入。': 'The original conversation in {tool} is not affected. If it continues, SuperLcm will not capture it again automatically; you can re-import it from Connect.', '删除': 'Delete', '已删除': 'Deleted', '清理旧对话': 'Clean up old conversations', '按最后更新时间批量删除。只删除 SuperLcm 里的原文存档和摘要，各工具里的原始对话不受影响。': 'Delete by last activity. Only SuperLcm\'s archived records and summaries are removed; the tools\' own conversations are not affected.', '最后更新早于': 'Last active before', '30 天前': '30 days ago', '90 天前': '90 days ago', '半年前': '6 months ago', '一年前': '1 year ago', '删除这些对话': 'Delete these conversations', '个对话': 'conversations', '条原文': 'records', '原文存档': 'archived originals', '索引与摘要': 'index and summaries', '全部工具': 'All tools', '符合条件的有 {n} 个对话，共 {r} 条原文。': '{n} conversations match, {r} records in total.', '没有符合条件的对话。': 'No conversations match.', '删除这 {n} 个对话': 'Delete these {n} conversations', '删除 {n} 个对话？': 'Delete {n} conversations?', '将从 SuperLcm 中删除这些对话的 {r} 条原文存档和全部摘要，删除后无法恢复。各工具里的原始对话不受影响。': 'Their {r} archived records and all summaries will be removed from SuperLcm. This cannot be undone. The tools\' own conversations are not affected.', '已删除 {n} 个对话': 'Deleted {n} conversations', '已在终端打开 Codex。': 'Codex is open in a terminal. ', '在它弹出的「Hooks need review」里选择信任，然后回来点「重新检查」。': 'Choose to trust the hooks in its "Hooks need review" screen, then come back and click Check again.', 'Codex 要求你亲自确认一次新钩子。点「打开 Codex 确认」，在弹出的界面里选择信任即可。': 'Codex asks you to approve new hooks once yourself. Click Open Codex to review and choose to trust them there.', '打开 Codex 确认': 'Open Codex to review', '重新检查': 'Check again', 'Codex 已信任 SuperLcm 的钩子，新开的 Codex 对话即可使用。': 'Codex already trusts SuperLcm\'s hooks; new Codex conversations will use them.', '（尚未信任 {n} 个）': ' ({n} not trusted yet)', '摘要（全局默认）': 'Summaries (global default)', '所有工具默认按这里生成摘要；某个工具想用别的方式，到「接入」页它的卡片上单独改。摘要仅用于导航，原文始终完整保存。': 'Every tool uses these summary settings unless you change it on its card under Connect. Summaries are for navigation; originals are always kept in full.', '生成方式': 'Method', '粒度': 'Granularity', '「对话模型生成」由当前对话的 AI 顺带完成，它读到的内容大多已在缓存中，费用最低；其他方式会在后台自动补齐。': '"Conversation model" lets the AI in the conversation write summaries as it goes; it mostly reads cached context, so it costs least. Other methods catch up in the background.', '有未保存的修改': 'Unsaved changes', '摘要': 'Summaries', 'AI 已成功调用': 'AI call verified', '仅导入': 'Import only', '未安装': 'Not installed', '接入后，新对话会自动存入 SuperLcm': 'Once connected, new conversations are saved to SuperLcm automatically', 'AI 最近一次调用：{t}': 'Last AI call: {t}', '已加载，等待 AI 首次调用': 'Loaded; waiting for the first AI call', '待重启': 'Restart needed', '检查接入': 'Check', '导入历史对话': 'Import past conversations', '状态': 'Status', '已存对话': 'Stored', '{n} 个': '{n}', '暂无': 'None', '本机未检测到': 'Not found on this computer', '导入：接入之前的对话，或暂不支持自动接入的工具（如 Hermes、Pi），可以从本机记录中挑选导入。只读取你选中的对话，不会调用模型。': 'Import: pick past conversations, or ones from tools without automatic capture (such as Hermes and Pi), from local records. Only the selected conversation is read, and no model is called.', '存储': 'Storage', '明暗': 'Light / dark', 'MCP 工具': 'MCP tools', '默认（{w}）': 'Default ({w})', '所有对话、原文存档和摘要都只存在这台电脑上的这个目录里。': 'All conversations, archived originals and summaries live only in this folder on this computer.', '返回对话列表': 'Back to conversations', '生成摘要…': 'Generate summaries…', '补齐摘要…': 'Catch up summaries…', '重新生成摘要…': 'Retry summaries…', '在后台调用本机 claude 命令，消耗你的 Claude 订阅额度。': 'Runs the local claude command in the background and uses your Claude subscription quota.', '在后台调用本机 codex 命令，消耗你的 Codex / ChatGPT 订阅额度。': 'Runs the local codex command in the background and uses your Codex / ChatGPT subscription quota.', '使用设置里保存的接口和密钥，按服务商价格计费。': 'Uses the endpoint and key saved in Settings; billed at the provider\'s rates.', '把尚未摘要的 {n} 条原文整理成分层摘要，方便浏览和接续。原文不会改动。': 'Turns {n} unsummarized records into layered summaries for browsing and handoff. Originals are not changed.', '预计调用模型约 {c} 次，在后台运行，可以关掉此页。': 'About {c} model calls, run in the background; you can close this page. ', '最后约 {n} 字还不够一段，暂时只保留原文。': 'The last {n} characters are less than one segment and stay as originals for now.', '用哪种方式生成': 'Generate with', '开始生成': 'Start', '配置自定义 API': 'Set up a custom API',
    '返回列表': 'Back to list', '对话编号，接续时使用': 'Conversation code, used to continue it elsewhere', '{n} 条原文': '{n} original records', '更新于 {t}': 'Updated {t}', '重命名': 'Rename', '换个工具继续': 'Continue in another tool',
    '正在生成摘要…': 'Generating summaries… ', '完成的部分会陆续出现在下方。': 'Finished parts will appear below as they complete.', '上次摘要生成失败。': 'The last summary run failed. ', '请确认所选方式可用（命令行工具已登录，或 API 密钥有效），然后重试。': 'Make sure the method works (the CLI is signed in, or the API key is valid), then retry.',
    '对话模型生成每轮只处理一段，跟不上新增内容。可以在后台一次补齐。': 'In-conversation mode handles one segment per turn and cannot keep up. Catch up in the background in one go.',
    '摘要目录': 'Summary outline', '收起全部': 'Collapse all', '最新 {n} 条（{r}）尚未摘要': 'Latest {n} records ({r}) not summarized yet', '查看原文': 'View originals', '此对话暂无摘要。': 'No summaries yet. ',
    '{n} 条原文已完整保存，AI 可按编号读取和搜索；接续时将提供最近的原文。': 'All {n} original records are stored; the AI can read and search them by number, and a handoff includes the most recent messages. ',
    '对话模型生成只在该对话继续进行时才会写摘要。': 'In-conversation mode only writes summaries while this conversation continues.', '查看最近原文': 'View recent originals', '读取中…': 'Loading…', '查看 {n} 条原文': 'View {n} originals', '第{n}层': 'L{n}',
    '已经在生成中': 'Already generating', '已开始在后台生成摘要': 'Started generating summaries in the background', '用户': 'User', '标题': 'Title',
    '{n} 条工具调用或系统记录（完整内容可用 lcm_read 读取）': '{n} tool calls or system records (full content via lcm_read)', '与原始记录逐字一致': 'identical to the source record', '关闭': 'Close',
    '这一段没有可显示的消息。': 'Nothing to show in this range.', 'AI 通过 {tool} 读取的内容与此一致': 'The AI reads exactly this through {tool}', '复制引用': 'Copy reference',
    '通过 SuperLcm 接续对话 #{code}「{name}」，继续之前的任务。': 'Continue SuperLcm conversation #{code} “{name}” and pick up the previous task.',
    '在目标工具中新建对话，发送下方指令即可接续。原文完整保留，可随时查证。': 'Start a new conversation in the target tool and send the line below. All originals stay available for checking.',
    '目标工具': 'Target tool', '已接入': 'Connected', '未接入': 'Not connected', '暂不支持自动接入': 'No automatic setup yet', '当前来源': 'current source', '在 {tool} 新对话中发送': 'Send in a new {tool} conversation',
    '接续指令': 'Handoff line', '或在终端中启动': 'Or start from a terminal', '目标对话将获得': 'The new conversation gets', '顶层摘要目录：已完成的工作与已定事项': 'The top-level outline: work done and decisions made',
    '最近的原文：衔接中断处的上下文': 'The most recent messages: context at the point it stopped', '按编号读取任意原文：细节不因压缩失真': 'Any original by number: no detail lost to compaction', '预览发送内容（{n} 字）': 'Preview what is sent ({n} characters)',
    '{tool} 尚未接入。': '{tool} is not connected yet. ', '{tool} 暂不支持自动接入。': '{tool} has no automatic setup yet. ', '完成一次接入后，即可从任意工具接续到这里。': 'Connect it once and you can continue here from any tool.',
    '可以在它的 MCP 设置中手动添加 SuperLcm 后再接续。': 'Add SuperLcm to its MCP settings manually, then continue.', '接入 {tool}': 'Connect {tool}', '对话名称': 'Conversation name', '保存': 'Save', '取消': 'Cancel', '已重命名': 'Renamed',
    '对话模型生成': 'In-conversation', '由对话中的 AI 顺带完成，读取多为缓存，最省钱': 'Written by the AI in the conversation; mostly cached reads, cheapest', 'Claude 订阅': 'Claude subscription', '后台自动补齐 · 调用 Claude CLI': 'Background catch-up · uses Claude CLI',
    'Codex 订阅': 'Codex subscription', '后台自动补齐 · 调用 Codex CLI': 'Background catch-up · uses Codex CLI', '自定义 API': 'Custom API', '后台自动补齐 · 使用你的 API 密钥': 'Background catch-up · uses your API key', '不生成摘要，原文照常保存': 'No summaries; originals are still stored',
    '暂不支持自动接入，可导入本机对话': 'No automatic setup yet; local conversations can be imported', '未找到 {tool} 命令行': '{tool} CLI not found', '尚未接入': 'Not connected',
    '已接入 · AI 已成功调用': 'Connected · the AI has called it', '已接入 · 等待首次调用': 'Connected · waiting for the first call', '已写入配置 · 重启 {tool} 后生效': 'Configured · restart {tool} to apply', '已接入 {tools}': 'Connected: {tools}', '尚未接入工具': 'No tool connected',
    '检查': 'Check', '接入': 'Connect', '导入对话': 'Import conversations', '最近调用：': 'Last call: ', '本机未检测到支持的工具。': 'No supported tool found on this computer.', '本机没有可导入的对话记录。': 'No importable conversations on this computer.',
    '检查本机配置': 'Check local configuration', '写入 SuperLcm 配置（先备份原文件）': 'Write SuperLcm configuration (originals backed up first)', '验证能否正常加载': 'Verify it loads',
    '接入后，{tool} 的对话会自动保存，其中的 AI 也能查阅全部已存对话。': 'Once connected, {tool} conversations are saved automatically and its AI can look up every stored conversation.',
    '将修改的文件': 'Files to change', 'MCP 配置：': 'MCP config: ', '（已存在，保持不变）': ' (already present, unchanged)', '事件钩子：': 'Hooks: ', '（新增 {list}）': ' (adds {list})', '（已齐全）': ' (complete)', '数据位置：': 'Data location: ',
    '完成': 'Done', '确认接入': 'Connect', '正在检查…': 'Checking…', '配置已齐全，可以直接验证。': 'Configuration is complete; you can verify directly.', '确认后才会修改配置文件，原文件会先备份。': 'Nothing changes until you confirm; original files are backed up first.',
    '检查失败：': 'Check failed: ', '正在写入…': 'Writing…', '配置已写入，但读回时不一致': 'Configuration was written but did not read back the same', '正在验证…': 'Verifying…', '还差一步：': 'One more step: ',
    '在 Codex 中输入 {cmd} 信任 SuperLcm 的钩子，然后新开一个对话即可使用。': 'in Codex, type {cmd} to trust the SuperLcm hooks, then start a new conversation.', '接入完成。': 'Connected. ',
    '新开的 Claude Code 对话会自动加载；已打开的对话需要在 {cmd} 中重连或重开。': 'New Claude Code conversations load it automatically; reconnect open ones in {cmd} or restart them.', '配置已保存，但验证未通过：': 'Configuration saved, but verification failed: ', '接入失败：': 'Setup failed: ',
    '导入 {tool} 的对话': 'Import {tool} conversations', '只读取你选中的对话，不调用模型。导入后可以接续到任何已接入的工具。': 'Only the conversations you pick are read, and no model is called. Imported conversations can be continued in any connected tool.',
    '已导入 · 查看': 'Imported · view', '加载更多': 'Load more', '已导入「{name}」': 'Imported “{name}”', '没有找到本机对话记录。': 'No local conversations found.',
    '模型': 'Model', '使用 CLI 默认模型': 'CLI default model', '接口协议': 'API protocol', 'OpenAI 兼容': 'OpenAI-compatible', '接口地址': 'Endpoint URL', '模型 ID': 'Model ID', '例如 claude-sonnet-5': 'e.g. claude-sonnet-5', 'API 密钥': 'API key',
    '已保存，留空保持不变': 'Saved; leave blank to keep', '首次保存必须填写': 'Required the first time',
    '自动补齐': 'Automatic catch-up',
    '不自动，需要时在对话页手动补齐': 'Off: catch up manually from the conversation page when needed',
    '跟不上时自动用「{m}」在后台补齐': 'When it falls behind, catch up in the background with {m}',
    '选了自动补齐后，积压到约 3 次模型调用，或对话结束时还有没写完的，就在后台补齐，消耗所选订阅的额度。': 'With automatic catch-up on, a background pass runs once the backlog reaches about 3 model calls, or when a conversation ends with work left. It uses the chosen subscription\'s quota.',
    '摘要滞后：还差约 {n} 次摘要（含向上合并）。': 'Summaries are behind: about {n} passes left, including merges. ',
    '需更新': 'Update',
    '点「接入」更新一次，以后 {tool} 升级不会影响 SuperLcm': 'Click Connect once more so {tool} updates no longer affect SuperLcm',
    '借用 {owner} 自带的 node 运行；{owner} 升级后若失灵，点「接入」即可恢复': 'Runs on the node bundled with {owner}; if it stops working after an {owner} update, click Connect to restore it',
    '对话中的 AI 每轮回答后顺带整理一段摘要。对话停下时摘要也会停；需要补齐时，可以在对话详情页一键补齐。': 'After each answer, the AI in the conversation summarizes one segment. When the conversation stops, so do summaries; catch up with one click on the conversation page.',
    '已保存': 'Saved', '约 {n} 字': 'About {n} characters', '每 {n} 段合并为上一层': 'Merge every {n} into the next level', '当前': 'current',
    '按当前设置：每段第 1 层摘要约覆盖 {a} 字原文，第 2 层约 {b} 字，第 3 层约 {c} 字。一段 100 万字的长对话大约产生 {n} 段第 1 层摘要。': 'With these settings, each level-1 summary covers about {a} characters of originals, level 2 about {b}, level 3 about {c}. A 1-million-character conversation produces about {n} level-1 summaries.',
    '已保存，只影响之后的新摘要': 'Saved; applies to new summaries only', '设置': 'Settings', '检测中…': 'Checking…',
    '接入后，该工具的对话会自动存入 SuperLcm，其中的 AI 也可查阅全部已存对话。': 'Once connected, the tool’s conversations are stored in SuperLcm automatically, and its AI can look up every stored conversation.',
    '导入本机的历史对话': 'Import past conversations from this computer',
    '接入之前的对话，或暂不支持自动接入的工具（如 Hermes、Pi），可以从本机记录中挑选导入。只读取你选中的对话，不会调用模型。': 'Conversations from before you connected, or from tools without automatic setup (such as Hermes and Pi), can be picked from local records. Only what you pick is read, and no model is called.',
    '摘要生成方式': 'Who writes summaries',
    '摘要仅用于导航，原文始终完整保存。「对话模型生成」由当前对话的 AI 顺带完成，它读到的内容大多已在缓存中，费用最低；其他方式会在后台自动补齐。': 'Summaries are only for navigation; originals are always stored in full. “In-conversation” is written by the conversation’s own AI, which mostly re-reads cached context, so it costs the least; the other options catch up in the background.',
    '摘要粒度': 'Summary granularity', '只影响之后新生成的摘要，已有摘要保持不变。': 'Applies to new summaries only; existing ones stay as they are.', '第 1 层每段原文': 'Originals per level-1 segment',
    '约 6,000 字 · 更细': 'About 6,000 characters · finer', '约 12,000 字 · 推荐': 'About 12,000 characters · recommended', '约 24,000 字 · 更省': 'About 24,000 characters · cheaper', '单段最多消息数': 'Max messages per segment',
    '16 条': '16 messages', '32 条 · 推荐': '32 messages · recommended', '64 条': '64 messages', '合并方式': 'Merging', '每 3 段合并为上一层': 'Merge every 3 into the next level', '每 4 段合并为上一层 · 推荐': 'Merge every 4 into the next level · recommended', '每 6 段合并为上一层': 'Merge every 6 into the next level',
    '按工具设置': 'Per tool', '未单独设置的工具沿用上方默认值。': 'Tools without their own setting use the default above.', '工具': 'Tool', '摘要生成': 'Summaries by', '实际生效': 'In effect', 'AI 可用的 MCP 工具': 'MCP tools available to the AI',
    '接入后，对话中的 AI 可调用以下工具。接入、导入、重命名等管理操作仅在控制台和命令行中进行。': 'Once connected, the AI in a conversation can call these tools. Setup, import, renaming and other management happen only in this console and the CLI.',
    '接续另一个对话：获取其顶层摘要与最近原文。': 'Continue another conversation: get its top-level summaries and recent originals.', '按名称、编号或关键词查找对话，并在摘要与原文中全文搜索。': 'Find conversations by name, code or keyword, and search summaries and originals.',
    '逐层展开摘要目录。': 'Expand the summary outline level by level.', '按编号读取原文，与原始记录逐字一致。': 'Read originals by number, identical to the source records.', '领取待摘要的原文（仅「对话模型生成」模式可用）。': 'Claim originals to summarize (in-conversation mode only).',
    '提交摘要，服务器校验原文后保存（同上）。': 'Submit a summary; the server verifies the originals before saving (same mode).', '存储与外观': 'Storage and appearance', '数据位置': 'Data location', '配色': 'Palette', '外观': 'Theme',
    '跟随系统': 'Follow system', '浅色': 'Light', '深色': 'Dark', '语言': 'Language', '跟随浏览器': 'Follow browser', '主菜单': 'Main menu', '搜索对话、摘要与原文': 'Search conversations, summaries and originals', '搜索': 'Search', '对话列表': 'Conversation list',
    '陶橙': 'Terracotta', '松石': 'Pine', '靛青': 'Indigo', '石墨': 'Graphite', '请求失败': 'Request failed', '未知原因': 'unknown reason', '无法导入': 'Cannot import',
    // Messages that come from the server.
    'Windows 批处理 CLI 启动器尚未验证；请指定原生可执行文件': 'Windows batch CLI launchers are not verified yet; point to the native executable.', '未找到 CLI，请先安装对应宿主': 'CLI not found; install the tool first.',
    '同名 superlcm 指向不同命令或索引；不覆盖已有配置，请先核对路径': 'An existing “superlcm” entry points to a different command or index; it will not be overwritten. Check the paths first.',
    '无法确定对话 ID': 'Cannot determine the conversation ID', '同 ID 已绑定其他源路径': 'This ID is already bound to another source path', '超过单会话 256 MiB 限制': 'Larger than the 256 MiB per-conversation limit',
    '配置不匹配此 SuperLcm 路径 / 索引；未执行未知命令': 'Configuration does not match this SuperLcm path or index; the unknown command was not run.', '未配置 SuperLcm MCP': 'SuperLcm MCP is not configured',
    'Claude 的 SuperLcm 配置尚未匹配此索引；请先确认接入。': 'Claude’s SuperLcm configuration does not match this index yet; connect first.', '无法启动 Claude CLI': 'Could not start Claude CLI', 'Claude CLI 无法启动': 'Could not start Claude CLI',
    'Claude 未完成 MCP 连接验证便退出': 'Claude exited before finishing the MCP check', 'Claude 控制响应超限': 'Claude control response too large', 'Claude 初始化失败，无法读取 MCP 状态': 'Claude failed to initialize; MCP status unavailable',
    '此 Claude CLI 不支持 mcp_status 控制请求': 'This Claude CLI does not support the mcp_status request', '真实 Claude CLI 已成功加载 SuperLcm；此前打开的会话仍需重载 MCP。': 'A real Claude CLI loaded SuperLcm; conversations opened earlier still need to reload MCP.',
    '此 harness 暂未实现自动接入；不会写入猜测的配置': 'Automatic setup is not implemented for this tool; no guessed configuration is written.', '宿主已禁用全部 hook；请先在宿主设置中确认启用': 'The tool has disabled all hooks; enable them in its settings first.',
    '同一 harness 的安装正在运行': 'Setup for this tool is already running', '配置已变化；请重新预览，不能覆盖并发更改': 'The configuration changed; check again rather than overwrite concurrent edits.',
    'hook 配置发生变化；停止，保留已有更改和备份': 'Hook configuration changed; stopped, keeping existing changes and backups.', '请先预览并确认接入': 'Check and confirm the setup first',
    '此对话暂无可见用户/助手文本': 'This conversation has no visible user or assistant text', '快照超过 32 MiB，请缩小来源': 'Snapshot is larger than 32 MiB', 'Pi 单次快照文件超过 32 MiB': 'Pi snapshot file is larger than 32 MiB',
    'Hermes 本机 schema 不兼容；不猜测数据格式': 'Local Hermes schema is not compatible; the format is not guessed.', '会话超过 10000 条可见消息，拒绝静默截断': 'More than 10,000 visible messages; refusing to truncate silently',
    // Server messages with a variable tail, matched by prefix.
    'Claude 连接验证超时（最后状态：': 'Claude connection check timed out (last status: ', 'Claude 报告 SuperLcm 状态：': 'Claude reports SuperLcm status: ', '官方 CLI 注册 MCP 失败；未写 hook。备份位于 ': 'Official CLI failed to register MCP; hooks not written. Backups at '
  }
}
const PREFIXED = ['Claude 连接验证超时（最后状态：', 'Claude 报告 SuperLcm 状态：', '官方 CLI 注册 MCP 失败；未写 hook。备份位于 ']
function pickLang() {
  let saved = null
  try { saved = localStorage.getItem('slcm-lang') } catch { /* private window */ }
  if (saved === 'zh' || LANGS[saved]) return saved
  return /^zh\b/i.test(navigator.language || '') ? 'zh' : 'en'
}
const LANG = pickLang()
const LOCALE = LANG === 'zh' ? 'zh-CN' : 'en-US'
document.documentElement.lang = LANG === 'zh' ? 'zh' : LANG
function t(text, vars) {
  let out = text
  const table = LANGS[LANG]
  if (table) {
    if (table[text] !== undefined) out = table[text]
    else if (LANG === 'zh') out = text
    else { const p = PREFIXED.find(k => String(text).startsWith(k)); if (p) out = table[p] + String(text).slice(p.length) }
  }
  return vars ? out.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m) : out
}
// Translate the static page shell once, before anything dynamic is rendered.
function translatePage() {
  if (LANG === 'zh') return
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const raw = node.nodeValue, key = raw.trim()
    if (key && /[一-龥]/.test(key)) node.nodeValue = raw.replace(key, t(key))
  }
  for (const el of document.querySelectorAll('[placeholder],[title],[aria-label]'))
    for (const attr of ['placeholder', 'title', 'aria-label']) { const v = el.getAttribute(attr); if (v && /[一-龥]/.test(v)) el.setAttribute(attr, t(v)) }
}
