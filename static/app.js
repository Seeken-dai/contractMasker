/* ==========================================
   Antigravity Masker Premium Application Logic
   ========================================== */

// 全局状态管理
const state = {
    activeTab: 'tab-mask',
    // 脱敏状态
    maskFile: null,
    fileToken: null,
    docStructure: [], // [{block_idx, text, style}]
    matches: [],      // [{block_idx, start, end, category, original_text, placeholder}]
    
    // 还原状态
    restoreFile: null,
    keyFile: null,
    
    // 规则管理
    rules: [],
    
    // 划词暂存
    pendingSelection: null // {block_idx, start, end, text}
};

// 类别样式后缀映射
const categoryClasses = {
    '人名': 'name',
    '企业名称': 'corp',
    '手机号': 'contact',
    '固定电话': 'contact',
    '电子邮箱': 'contact',
    '时间信息': 'contact',
    '银行卡号': 'finance',
    '统一社会信用代码/税号': 'finance',
    '身份证号': 'finance',
    '大写金额': 'finance',
    '数值金额': 'finance',
    '百分比': 'finance'
};

document.addEventListener('DOMContentLoaded', () => {
    loadSystemConfig();
    initTheme();
    initNavigation();
    initUploadEvents();
    initMaskingEvents();
    initRestoreEvents();
    initRulesEvents();
    initSelectionBubble();
    
    // 初始加载规则
    loadRules();
});

// --- 主题切换逻辑 (Ant Design Light/Dark Switcher) ---
function initTheme() {
    const themeBtn = document.getElementById('btn-theme-toggle');
    if (!themeBtn) return;
    const sunIcon = themeBtn.querySelector('.sun-icon');
    const moonIcon = themeBtn.querySelector('.moon-icon');
    
    const savedTheme = localStorage.getItem('theme');
    const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    
    const isDark = savedTheme === 'dark' || (!savedTheme && systemPrefersDark);
    
    if (isDark) {
        document.body.classList.add('dark-theme');
        sunIcon.classList.add('hidden');
        moonIcon.classList.remove('hidden');
    } else {
        document.body.classList.remove('dark-theme');
        sunIcon.classList.remove('hidden');
        moonIcon.classList.add('hidden');
    }
    
    themeBtn.addEventListener('click', () => {
        const currentlyDark = document.body.classList.contains('dark-theme');
        if (currentlyDark) {
            document.body.classList.remove('dark-theme');
            sunIcon.classList.remove('hidden');
            moonIcon.classList.add('hidden');
            localStorage.setItem('theme', 'light');
            showToast('已切换至明亮模式', 'info');
        } else {
            document.body.classList.add('dark-theme');
            sunIcon.classList.add('hidden');
            moonIcon.classList.remove('hidden');
            localStorage.setItem('theme', 'dark');
            showToast('已切换至暗色模式', 'info');
        }
    });
}

// --- 导航切换 ---
function initNavigation() {
    const tabs = document.querySelectorAll('.nav-tab');
    if (tabs.length === 0) {
        // 独立页面模式：自适应激活状态
        if (document.getElementById('tab-mask')) {
            state.activeTab = 'tab-mask';
        } else if (document.getElementById('tab-restore')) {
            state.activeTab = 'tab-restore';
        }
        return;
    }
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const target = tab.dataset.target;
            document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
            
            tab.classList.add('active');
            document.getElementById(target).classList.add('active');
            state.activeTab = target;
            
            if (target === 'tab-rules') {
                loadRules();
            }
        });
    });
}

// --- Toast 提示工具 ---
function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    let icon = '';
    if (type === 'success') {
        icon = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    } else if (type === 'danger') {
        icon = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
    } else {
        icon = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="12" x2="12" y2="16"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;
    }

    toast.innerHTML = `
        <span style="display: flex; align-items: center; gap: 8px;">${icon} ${message}</span>
        <span style="cursor:pointer; opacity:0.6; font-size:16px;" onclick="this.parentElement.remove()">&times;</span>
    `;
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(20px)';
        toast.style.transition = 'all 0.5s';
        setTimeout(() => toast.remove(), 500);
    }, 4000);
}

// --- 占位符合并算法 ---
function assignPlaceholders(matchesList) {
    const categoryCounters = {}; 
    const textToPlaceholder = {}; 
    
    // 按物理顺序排序
    const sorted = [...matchesList].sort((a, b) => {
        if (a.block_idx !== b.block_idx) return a.block_idx - b.block_idx;
        return a.start - b.start;
    });
    
    sorted.forEach(m => {
        const key = `${m.category}_${m.original_text}`;
        if (!textToPlaceholder[key]) {
            if (!categoryCounters[m.category]) {
                categoryCounters[m.category] = 1;
            } else {
                categoryCounters[m.category]++;
            }
            textToPlaceholder[key] = `[${m.category}_${categoryCounters[m.category]}]`;
        }
        m.placeholder = textToPlaceholder[key];
    });
    
    return sorted;
}

// --- 文件上传处理 (脱敏和还原) ---
function initUploadEvents() {
    // 1. 脱敏文档上传
    const maskDropZone = document.getElementById('mask-drop-zone');
    const maskInput = document.getElementById('mask-file-input');
    
    ['dragenter', 'dragover'].forEach(eventName => {
        maskDropZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            maskDropZone.classList.add('dragover');
        }, false);
    });
    
    ['dragleave', 'drop'].forEach(eventName => {
        maskDropZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            maskDropZone.classList.remove('dragover');
        }, false);
    });
    
    maskDropZone.addEventListener('drop', (e) => {
        const files = e.dataTransfer.files;
        if (files.length) handleMaskFileUpload(files[0]);
    });
    
    maskInput.addEventListener('change', () => {
        if (maskInput.files.length) handleMaskFileUpload(maskInput.files[0]);
    });

    // 2. 还原文档上传
    const restoreDropZone = document.getElementById('restore-drop-zone');
    const restoreInput = document.getElementById('restore-file-input');
    
    ['dragenter', 'dragover'].forEach(eventName => {
        restoreDropZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            restoreDropZone.classList.add('dragover');
        }, false);
    });
    
    ['dragleave', 'drop'].forEach(eventName => {
        restoreDropZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            restoreDropZone.classList.remove('dragover');
        }, false);
    });
    
    restoreDropZone.addEventListener('drop', (e) => {
        const files = e.dataTransfer.files;
        if (files.length) handleRestoreFileUpload(files[0]);
    });
    
    restoreInput.addEventListener('change', () => {
        if (restoreInput.files.length) handleRestoreFileUpload(restoreInput.files[0]);
    });
}

// 上传脱敏原文档
async function handleMaskFileUpload(file) {
    if (!file.name.endsWith('.docx')) {
        showToast('只支持导入 .docx 格式的 Word 文档', 'danger');
        return;
    }
    
    state.maskFile = file;
    showToast('正在解析文档结构，请稍候...', 'info');
    
    const formData = new FormData();
    formData.append('file', file);
    
    try {
        const response = await fetch('/api/upload', {
            method: 'POST',
            body: formData
        });
        
        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || '文档解析失败');
        }
        
        const data = await response.json();
        state.fileToken = data.file_token;
        state.docStructure = data.structure;
        state.matches = data.suggested_matches;
        
        // 成功跳转交互界面
        document.getElementById('mask-upload-screen').classList.add('hidden');
        document.getElementById('mask-interactive-screen').classList.remove('hidden');
        
        renderDocumentPreview();
        renderMatchesTable();
        showToast('文档加载成功，已自动初筛敏感词', 'success');
    } catch (e) {
        showToast(e.message, 'danger');
        state.maskFile = null;
    }
}

// --- 渲染文档预览与划词核心算法 ---
function renderDocumentPreview() {
    const viewer = document.getElementById('doc-viewer');
    viewer.innerHTML = '';
    
    state.docStructure.forEach(block => {
        const paraEl = document.createElement('p');
        paraEl.dataset.block = block.block_idx;
        
        // 如果此段落有敏感词标注，将其分块渲染为 HTML
        const blockMatches = state.matches.filter(m => m.block_idx === block.block_idx);
        
        if (blockMatches.length === 0) {
            paraEl.textContent = block.text;
        } else {
            // 对敏感词排序，确保从左到右非重合替换
            const sortedMatches = [...blockMatches].sort((a, b) => a.start - b.start);
            
            let lastIdx = 0;
            const fragments = [];
            
            sortedMatches.forEach((m, mIdx) => {
                // 插入普通文本部分
                if (m.start > lastIdx) {
                    fragments.push(document.createTextNode(block.text.substring(lastIdx, m.start)));
                }
                
                // 插入高亮标记
                const tagEl = document.createElement('span');
                const suffix = categoryClasses[m.category] || 'other';
                tagEl.className = `mask-tag mask-tag-${suffix}`;
                tagEl.dataset.tagId = `${m.block_idx}_${m.start}_${m.end}`;
                tagEl.textContent = m.original_text;
                tagEl.title = `分类: ${m.category} (代号: ${m.placeholder || '待定'})`;
                
                // 绑定点击移除事件
                tagEl.addEventListener('click', (e) => {
                    e.stopPropagation();
                    removeMatch(m.block_idx, m.start, m.end);
                });
                
                fragments.push(tagEl);
                lastIdx = m.end;
            });
            
            // 插入剩余尾部文本
            if (lastIdx < block.text.length) {
                fragments.push(document.createTextNode(block.text.substring(lastIdx)));
            }
            
            fragments.forEach(f => paraEl.appendChild(f));
        }
        
        viewer.appendChild(paraEl);
    });
}

// 刷新右侧标注列表
function renderMatchesTable() {
    // 重新计算并排序占位符
    state.matches = assignPlaceholders(state.matches);
    
    const countBadge = document.getElementById('match-count-badge');
    countBadge.textContent = `${state.matches.length} 个`;
    
    const tbody = document.getElementById('matches-table-body');
    tbody.innerHTML = '';
    
    if (state.matches.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="text-muted" style="text-align: center; padding: 32px 0;">暂无任何敏感词标注</td></tr>`;
        return;
    }
    
    state.matches.forEach(m => {
        const tr = document.createElement('tr');
        tr.style.cursor = 'pointer';
        tr.title = '点击可在左侧预览中定位此词';
        tr.addEventListener('click', (e) => {
            if (e.target.classList.contains('btn-delete-match')) return;
            scrollToTag(m.block_idx, m.start, m.end);
        });
        
        const badgeSuffix = categoryClasses[m.category] || 'other';
        
        tr.innerHTML = `
            <td><strong>${escapeHtml(m.original_text)}</strong></td>
            <td><span class="badge legend-${badgeSuffix}">${m.category}</span></td>
            <td><code style="color: #c084fc;">${m.placeholder}</code></td>
            <td style="text-align: right;">
                <button class="btn-delete-match">移除</button>
            </td>
        `;
        
        tr.querySelector('.btn-delete-match').addEventListener('click', (e) => {
            e.stopPropagation();
            removeMatch(m.block_idx, m.start, m.end);
        });
        
        tbody.appendChild(tr);
    });
}

function removeMatch(block_idx, start, end) {
    state.matches = state.matches.filter(m => !(m.block_idx === block_idx && m.start === start && m.end === end));
    renderDocumentPreview();
    renderMatchesTable();
}

function scrollToTag(block_idx, start, end) {
    const tagId = `${block_idx}_${start}_${end}`;
    const tagEl = document.querySelector(`[data-tag-id="${tagId}"]`);
    
    if (tagEl) {
        // 平滑滚动定位至可视区中心
        tagEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        
        // 触发发光/放大闪烁动画
        tagEl.classList.add('highlight-pulse');
        
        // 动画播放完后移除 class，便于下次再次触发
        setTimeout(() => {
            tagEl.classList.remove('highlight-pulse');
        }, 1200);
    } else {
        showToast('预览区域未找到该敏感词，可能已被手动修改', 'warning');
    }
}

// --- 划词监听与气泡逻辑 ---
function initSelectionBubble() {
    const bubble = document.getElementById('selection-bubble');
    const viewer = document.getElementById('doc-viewer');
    if (!bubble || !viewer) return;
    
    // 划词鼠标抬起事件
    viewer.addEventListener('mouseup', handleTextSelection);
    
    // 划词按钮点击
    bubble.querySelectorAll('.bubble-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const category = btn.dataset.category;
            if (state.pendingSelection) {
                const { block_idx, start, end, text } = state.pendingSelection;
                
                // 检查是否冲突
                const conflict = state.matches.some(m => 
                    m.block_idx === block_idx && 
                    ((start >= m.start && start < m.end) || (end > m.start && end <= m.end) || (start <= m.start && end >= m.end))
                );
                
                if (conflict) {
                    showToast('所选区域已被其它高亮标记覆盖，请先移除冲突标记', 'warning');
                } else {
                    state.matches.push({
                        block_idx,
                        start,
                        end,
                        category,
                        original_text: text,
                        placeholder: ''
                    });
                    renderDocumentPreview();
                    renderMatchesTable();
                    showToast(`成功标注 "${text}" 为 [${category}]`, 'success');
                }
            }
            hideBubble();
        });
    });
    
    // 其它区域点击隐藏气泡
    document.addEventListener('mousedown', (e) => {
        if (!bubble.contains(e.target) && !viewer.contains(e.target)) {
            hideBubble();
        }
    });
}

function handleTextSelection() {
    const selection = window.getSelection();
    if (!selection.rangeCount) return;
    
    const range = selection.getRangeAt(0);
    const selectedText = selection.toString().trim();
    
    if (selectedText.length === 0) {
        hideBubble();
        return;
    }
    
    // 定位目标段落元素
    let paraEl = range.commonAncestorContainer;
    while (paraEl && paraEl.nodeName !== 'P') {
        paraEl = paraEl.parentElement;
    }
    
    if (!paraEl || paraEl.dataset.block === undefined) {
        hideBubble();
        return;
    }
    
    const block_idx = parseInt(paraEl.dataset.block);
    
    // 精确计算划词在整个段落纯文本中的起止点绝对坐标
    const coords = getSelectionCoordsInParagraph(paraEl, range);
    if (!coords) return;
    
    state.pendingSelection = {
        block_idx,
        start: coords.start,
        end: coords.end,
        text: selectedText
    };
    
    // 定位弹出气泡
    const rect = range.getBoundingClientRect();
    const bubble = document.getElementById('selection-bubble');
    bubble.classList.remove('hidden');
    
    // 居中于选区上方
    const bubbleWidth = bubble.offsetWidth;
    const bubbleHeight = bubble.offsetHeight;
    
    let top = rect.top + window.scrollY - bubbleHeight - 12;
    let left = rect.left + window.scrollX + (rect.width / 2) - (bubbleWidth / 2);
    
    // 边缘防溢出处理
    if (top < 10) top = rect.bottom + window.scrollY + 12;
    if (left < 10) left = 10;
    if (left + bubbleWidth > window.innerWidth - 10) left = window.innerWidth - bubbleWidth - 10;
    
    bubble.style.top = `${top}px`;
    bubble.style.left = `${left}px`;
}

// 绝对坐标换算算法
function getSelectionCoordsInParagraph(paraEl, range) {
    let startOffset = 0;
    let endOffset = 0;
    let foundStart = false;
    let foundEnd = false;
    let charCount = 0;
    
    function traverse(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            if (!foundStart) {
                if (node === range.startContainer) {
                    startOffset = charCount + range.startOffset;
                    foundStart = true;
                }
            }
            if (!foundEnd) {
                if (node === range.endContainer) {
                    endOffset = charCount + range.endOffset;
                    foundEnd = true;
                }
            }
            charCount += node.textContent.length;
        } else {
            for (let i = 0; i < node.childNodes.length; i++) {
                traverse(node.childNodes[i]);
                if (foundStart && foundEnd) break;
            }
        }
    }
    
    traverse(paraEl);
    
    if (foundStart && foundEnd) {
        return { start: startOffset, end: endOffset };
    }
    return null;
}

function hideBubble() {
    const bubble = document.getElementById('selection-bubble');
    bubble.classList.add('hidden');
    state.pendingSelection = null;
}

// --- 执行脱敏操作 ---
function initMaskingEvents() {
    const cancelBtn = document.getElementById('btn-cancel-mask');
    if (!cancelBtn) return;
    
    cancelBtn.addEventListener('click', () => {
        state.maskFile = null;
        state.fileToken = null;
        state.matches = [];
        document.getElementById('mask-file-input').value = '';
        document.getElementById('mask-interactive-screen').classList.add('hidden');
        document.getElementById('mask-upload-screen').classList.remove('hidden');
    });
    
    document.getElementById('btn-execute-mask').addEventListener('click', async () => {
        if (state.matches.length === 0) {
            showToast('未标注任何敏感词，确定不需要脱敏吗？', 'warning');
        }
        
        showToast('正在构建安全脱敏映射关系并生成文档...', 'info');
        
        try {
            const response = await fetch('/api/mask', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    file_token: state.fileToken,
                    matches: state.matches
                })
            });
            
            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.detail || '脱敏执行出错');
            }
            
            const data = await response.json();
            
            // 展示成功页，并关联下载链接
            document.getElementById('mask-interactive-screen').classList.add('hidden');
            document.getElementById('mask-success-screen').classList.remove('hidden');
            
            document.getElementById('masked-file-name').textContent = data.filename;
            
            const dlLink = document.getElementById('download-doc-link');
            dlLink.href = data.download_url;
            
            // 绑定密钥 JSON 导出下载
            const dlKeyBtn = document.getElementById('download-key-btn');
            
            // 重新绑定，清空之前绑定的 Listener
            const newDlKeyBtn = dlKeyBtn.cloneNode(true);
            dlKeyBtn.parentNode.replaceChild(newDlKeyBtn, dlKeyBtn);
            
            newDlKeyBtn.addEventListener('click', () => {
                const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(data.mappings, null, 4));
                const dlAnchor = document.createElement('a');
                dlAnchor.setAttribute("href", dataStr);
                dlAnchor.setAttribute("download", `key_${data.uuid.substring(0,8)}.json`);
                document.body.appendChild(dlAnchor);
                dlAnchor.click();
                dlAnchor.remove();
                showToast('备份密钥包下载完成，请妥善保存！', 'success');
            });
            
            showToast('文档脱敏执行成功！', 'success');
        } catch (e) {
            showToast(e.message, 'danger');
        }
    });
    
    document.getElementById('btn-restart-mask').addEventListener('click', () => {
        state.maskFile = null;
        state.fileToken = null;
        state.matches = [];
        document.getElementById('mask-file-input').value = '';
        document.getElementById('mask-success-screen').classList.add('hidden');
        document.getElementById('mask-upload-screen').classList.remove('hidden');
    });
}

// --- 还原流程控制 ---
function initRestoreEvents() {
    const keyInput = document.getElementById('key-file-input');
    const keyDropZone = document.getElementById('key-drop-zone');
    if (!keyInput || !keyDropZone) return;
    
    // 拖拽密钥
    ['dragenter', 'dragover'].forEach(eventName => {
        keyDropZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            keyDropZone.style.borderColor = 'var(--primary)';
        }, false);
    });
    ['dragleave', 'drop'].forEach(eventName => {
        keyDropZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            keyDropZone.style.borderColor = 'rgba(255, 255, 255, 0.1)';
        }, false);
    });
    
    keyDropZone.addEventListener('drop', (e) => {
        const files = e.dataTransfer.files;
        if (files.length) handleKeyFileSelect(files[0]);
    });
    
    keyInput.addEventListener('change', () => {
        if (keyInput.files.length) handleKeyFileSelect(keyInput.files[0]);
    });
    
    document.getElementById('btn-cancel-restore').addEventListener('click', resetRestoreScreen);
    
    // 点击执行外置密钥包的还原
    document.getElementById('btn-execute-restore-with-key').addEventListener('click', () => {
        if (!state.restoreFile || !state.keyFile) return;
        executeRestore(state.restoreFile, state.keyFile);
    });
}

// 上传要还原的文件
async function handleRestoreFileUpload(file) {
    if (!file.name.endsWith('.docx')) {
        showToast('只支持上传脱敏后的 .docx 合同', 'danger');
        return;
    }
    
    state.restoreFile = file;
    showToast('正在检测文件并检索关联记录...', 'info');
    
    const formData = new FormData();
    formData.append('file', file);
    
    try {
        // 先尝试静默配对本地数据库
        const response = await fetch('/api/restore', {
            method: 'POST',
            body: formData
        });
        
        if (response.ok) {
            // 本地直接配对还原成功，响应是文件流，直接下载
            const blob = await response.blob();
            downloadBlob(blob, `restored_${file.name.replace('masked_', '')}`);
            showToast('检测到本地配对数据库，文档已自动一键恢复！', 'success');
            resetRestoreScreen();
        } else if (response.status === 404) {
            // 本地无记录，切入密钥包上传面板
            const err = await response.json();
            showToast(err.detail, 'warning');
            document.getElementById('restore-upload-screen').classList.add('hidden');
            document.getElementById('restore-key-screen').classList.remove('hidden');
        } else {
            const err = await response.json();
            throw new Error(err.detail || '还原请求异常');
        }
    } catch (e) {
        showToast(e.message, 'danger');
        state.restoreFile = null;
    }
}

// 选择外置密钥包文件
function handleKeyFileSelect(file) {
    if (!file.name.endsWith('.json')) {
        showToast('密钥包必须是 .json 格式的备份文件', 'danger');
        return;
    }
    
    state.keyFile = file;
    document.getElementById('key-file-status').textContent = `已选择：${file.name}`;
    document.getElementById('key-file-status').style.color = 'var(--primary)';
    
    // 解禁按钮
    const executeBtn = document.getElementById('btn-execute-restore-with-key');
    executeBtn.classList.remove('disabled');
}

// 双轨模式：外置密钥包还原执行
async function executeRestore(docFile, keyFile) {
    showToast('正在上传并解析密钥包恢复内容...', 'info');
    
    const formData = new FormData();
    formData.append('file', docFile);
    formData.append('key_file', keyFile);
    
    try {
        const response = await fetch('/api/restore', {
            method: 'POST',
            body: formData
        });
        
        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || '密钥包校验或还原失败');
        }
        
        const blob = await response.blob();
        downloadBlob(blob, `restored_${docFile.name.replace('masked_', '')}`);
        showToast('凭密钥包还原成功！', 'success');
        resetRestoreScreen();
    } catch (e) {
        showToast(e.message, 'danger');
    }
}

function resetRestoreScreen() {
    state.restoreFile = null;
    state.keyFile = null;
    document.getElementById('restore-file-input').value = '';
    document.getElementById('key-file-input').value = '';
    document.getElementById('key-file-status').textContent = '尚未选择密钥文件';
    document.getElementById('key-file-status').style.color = '';
    
    const executeBtn = document.getElementById('btn-execute-restore-with-key');
    executeBtn.classList.add('disabled');
    
    document.getElementById('restore-key-screen').classList.add('hidden');
    document.getElementById('restore-upload-screen').classList.remove('hidden');
}

function downloadBlob(blob, filename) {
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
}

// --- 规则管理逻辑 ---
async function loadRules() {
    try {
        const response = await fetch('/api/rules');
        if (!response.ok) throw new Error('拉取规则数据失败');
        state.rules = await response.json();
        renderRulesGrid();
    } catch (e) {
        showToast(e.message, 'danger');
    }
}

function renderRulesGrid() {
    const container = document.getElementById('rules-container');
    if (!container) return;
    container.innerHTML = '';
    
    state.rules.forEach(rule => {
        const div = document.createElement('div');
        div.className = 'rule-item';
        
        // 区分内置和自定义规则 (内置规则前 9 项一般不可以随便删除，或者我们根据 pattern 和名称加锁)
        const isBuiltin = ["手机号", "固定电话", "电子邮箱", "统一社会信用代码/税号", "银行卡号", "身份证号", "时间信息", "企业名称", "大写金额", "数值金额", "百分比", "人名"].includes(rule.name);
        
        div.innerHTML = `
            <div>
                <div class="rule-item-header">
                    <span class="rule-title">${escapeHtml(rule.name)}</span>
                    <label class="switch">
                        <input type="checkbox" ${rule.is_enabled ? 'checked' : ''} onchange="toggleRule(${rule.id}, this.checked)">
                        <span class="slider"></span>
                    </label>
                </div>
                <div class="rule-desc">${escapeHtml(rule.description || '无说明描述')}</div>
                ${rule.pattern ? `<div class="rule-code" title="正则表达式">${escapeHtml(rule.pattern)}</div>` : `<div class="rule-code" style="color:#6b7280; font-style:italic;">依赖 Jieba 语义初筛及手动划词</div>`}
            </div>
            <div class="rule-footer">
                <span class="badge">${isBuiltin ? '内置规则' : '自定义'}</span>
                ${isBuiltin ? '' : `<button class="btn-delete-rule" onclick="deleteRule(${rule.id})">
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                    删除
                </button>`}
            </div>
        `;
        container.appendChild(div);
    });
}

// 快速启用/停用规则
async function toggleRule(ruleId, isChecked) {
    const rule = state.rules.find(r => r.id === ruleId);
    if (!rule) return;
    
    try {
        const response = await fetch(`/api/rules/${ruleId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: rule.name,
                pattern: rule.pattern,
                is_enabled: isChecked ? 1 : 0,
                description: rule.description
            })
        });
        
        if (!response.ok) throw new Error('修改状态失败');
        rule.is_enabled = isChecked ? 1 : 0;
        showToast(`规则 [${rule.name}] 已${isChecked ? '启用' : '禁用'}`, 'info');
    } catch (e) {
        showToast(e.message, 'danger');
        loadRules(); // 刷新恢复勾选
    }
}

// 添加、删除规则
function initRulesEvents() {
    const modal = document.getElementById('rule-modal');
    const addBtn = document.getElementById('btn-add-rule');
    const closeBtn = document.getElementById('btn-close-modal');
    const saveBtn = document.getElementById('btn-save-rule');
    if (!modal || !addBtn || !closeBtn || !saveBtn) return;
    
    addBtn.addEventListener('click', () => {
        // 清空表单
        document.getElementById('rule-name-input').value = '';
        document.getElementById('rule-pattern-input').value = '';
        document.getElementById('rule-desc-input').value = '';
        modal.classList.remove('hidden');
    });
    
    closeBtn.addEventListener('click', () => {
        modal.classList.add('hidden');
    });
    
    saveBtn.addEventListener('click', async () => {
        const name = document.getElementById('rule-name-input').value.trim();
        const pattern = document.getElementById('rule-pattern-input').value.trim();
        const description = document.getElementById('rule-desc-input').value.trim();
        
        if (!name) {
            showToast('规则名称不能为空', 'warning');
            return;
        }
        
        // 如果有正则，简单校验正则是否正确
        if (pattern) {
            try {
                new RegExp(pattern);
            } catch (e) {
                showToast('输入的正则表达式不合法', 'danger');
                return;
            }
        }
        
        try {
            const response = await fetch('/api/rules', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name,
                    pattern: pattern || null,
                    is_enabled: 1,
                    description
                })
            });
            
            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.detail || '保存失败');
            }
            
            showToast(`规则 [${name}] 创建成功`, 'success');
            modal.classList.add('hidden');
            loadRules();
        } catch (e) {
            showToast(e.message, 'danger');
        }
    });
}

async function deleteRule(ruleId) {
    if (!confirm('确定要彻底删除这条自定义规则吗？')) return;
    
    try {
        const response = await fetch(`/api/rules/${ruleId}`, {
            method: 'DELETE'
        });
        
        if (!response.ok) throw new Error('删除失败');
        showToast('自定义规则已删除', 'success');
        loadRules();
    } catch (e) {
        showToast(e.message, 'danger');
    }
}

// --- 辅助转义函数 ---
function escapeHtml(string) {
    const matchHtmlRegExp = /["'&<>]/;
    const str = '' + string;
    const match = matchHtmlRegExp.exec(str);

    if (!match) {
        return str;
    }

    let escape;
    let html = '';
    let index = 0;
    let lastIndex = 0;

    for (index = match.index; index < str.length; index++) {
        switch (str.charCodeAt(index)) {
            case 34: // "
                escape = '&quot;';
                break;
            case 38: // &
                escape = '&amp;';
                break;
            case 39: // '
                escape = '&#39;';
                break;
            case 60: // <
                escape = '&lt;';
                break;
            case 62: // >
                escape = '&gt;';
                break;
            default:
                continue;
        }

        if (lastIndex !== index) {
            html += str.substring(lastIndex, index);
        }

        lastIndex = index + 1;
        html += escape;
    }

    return lastIndex !== index
        ? html + str.substring(lastIndex, index)
        : html;
}

// --- 加载系统配置（自定义产品名称） ---
async function loadSystemConfig() {
    try {
        const response = await fetch('/api/config');
        if (response.ok) {
            const data = await response.json();
            if (data.app_name) {
                // 1. 替换网页 Title
                document.title = data.app_name;
                // 2. 替换左上角 Logo 中的文本
                const logoEl = document.getElementById('logo-text');
                if (logoEl) {
                    if (data.app_name.includes("智能脱敏")) {
                        const htmlContent = escapeHtml(data.app_name).replace("智能脱敏", '<span class="logo-accent">智能脱敏</span>');
                        logoEl.innerHTML = htmlContent;
                    } else {
                        logoEl.innerText = data.app_name;
                    }
                }
            }
        }
    } catch (e) {
        console.error("加载系统配置失败:", e);
    }
}
