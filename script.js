'use strict';
const $ = id => document.getElementById(id);
const audio = $('audio');
const KEY = 'playrecap_private_v1';
let saved = {};
try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
saved.progress ||= {};
let books = [], currentBook = null, index = -1, pendingSeek = null, generation = 0;
let deadline = 0, stopAfterChapter = false, lastSave = 0, uploading = false;
const status = text => $('status').textContent = text;
function notice(text) { $('notice').textContent = text; $('notice').hidden = !text; }
function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(saved)); }
    catch { notice('浏览器无法保存进度。请检查存储空间或隐私设置。'); }
}
function format(seconds) {
    seconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
    const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}
async function api(path, body) {
    const res = await fetch(path, body === undefined ? {} : {
        method: 'POST', headers: {'Content-Type': 'application/json', 'X-Recap-Request': '1'}, body: JSON.stringify(body)
    });
    const value = await res.json();
    if (!res.ok) {
        if (res.status === 401 && path !== '/api/login') { audio.pause(); showLogin(); }
        throw new Error(value.error || '请求失败，请重试。');
    }
    return value;
}
function showLogin() { $('login').hidden = false; $('app').hidden = true; }
async function refresh() {
    const data = await api('/api/library');
    books = data.books;
    $('login').hidden = true; $('app').hidden = false;
    // Keep the active chapter stable while new files are added to the library.
    if (currentBook) {
        const chapterId = currentBook.chapters[index]?.id;
        const updated = books.find(b => b.id === currentBook.id);
        const updatedIndex = updated?.chapters.findIndex(c => c.id === chapterId) ?? -1;
        if (updatedIndex >= 0) { currentBook = updated; index = updatedIndex; renderChapters(); }
        else { audio.pause(); currentBook = null; index = -1; audio.removeAttribute('src'); audio.load(); status('当前音频已被移走，请重新选择。'); renderChapters(); }
    }
    renderBooks();
    if (!currentBook && books.length) {
        const book = books.find(b => b.id === saved.lastBook) || books[0];
        selectBook(book, false);
    }
    updateControls();
}
function saveProgress(force = false) {
    if (!currentBook || index < 0 || pendingSeek !== null || audio.readyState === 0) return;
    if (!force && Date.now() - lastSave < 3000) return;
    saved.progress[currentBook.id] = {chapterId: currentBook.chapters[index].id, time: audio.currentTime, completed: audio.ended && index === currentBook.chapters.length-1};
    saved.lastBook = currentBook.id;
    persist(); lastSave = Date.now();
    const shelf = $('books').querySelector(`[data-book-id="${currentBook.id}"] small`);
    if (shelf) shelf.textContent = `${currentBook.chapters.length} 章 · ` + (saved.progress[currentBook.id].completed ? '已听完' : `上次听到第 ${index+1} 章 ${format(audio.currentTime)}`);
    $('save-status').textContent = '已记住 · ' + format(audio.currentTime) + '（当前浏览器）';
}
function renderBooks() {
    $('books').replaceChildren(); $('empty').hidden = books.length > 0;
    for (const book of books) {
        const button = document.createElement('button'); button.dataset.bookId = book.id; button.className = 'book' + (currentBook?.id === book.id ? ' active' : '');
        const icon = document.createElement('span'); icon.className = 'book-icon'; icon.textContent = '◒';
        const text = document.createElement('span'), title = document.createElement('strong'), subtitle = document.createElement('small');
        title.textContent = book.title;
        const progress = saved.progress[book.id];
        const chapter = book.chapters.findIndex(c => c.id === progress?.chapterId);
        subtitle.textContent = `${book.chapters.length} 章` + (progress?.completed ? ' · 已听完' : chapter >= 0 ? ` · 上次听到第 ${chapter+1} 章 ${format(progress.time)}` : ' · 尚未开始');
        text.append(title, subtitle); button.append(icon, text);
        button.addEventListener('click', () => selectBook(book, true)); $('books').append(button);
    }
}
function renderChapters() {
    $('chapters').replaceChildren(); $('chapters-panel').hidden = !currentBook;
    if (!currentBook) return;
    $('chapter-count').textContent = currentBook.chapters.length + ' 章';
    currentBook.chapters.forEach((chapter, i) => {
        const row = document.createElement('li'), button = document.createElement('button');
        button.className = i === index ? 'active' : '';
        if (i === index) button.setAttribute('aria-current', 'true');
        const number = document.createElement('span'), title = document.createElement('span');
        number.textContent = String(i+1).padStart(2,'0'); title.textContent = chapter.title;
        button.append(number, title); button.addEventListener('click', () => selectChapter(i, 0, true)); row.append(button); $('chapters').append(row);
    });
}
function selectBook(book, autoplay) {
    if (currentBook?.id === book.id && index >= 0) { if (autoplay) play(); return; }
    saveProgress(true); audio.pause(); currentBook = book;
    const progress = saved.progress[book.id];
    let i = book.chapters.findIndex(c => c.id === progress?.chapterId);
    if (i < 0) i = 0;
    selectChapter(i, progress?.completed ? 0 : Number(progress?.time) || 0, autoplay, false);
}
function selectChapter(i, time = 0, autoplay = true, saveOld = true) {
    if (!currentBook || !currentBook.chapters[i]) return;
    if (saveOld) saveProgress(true);
    audio.pause(); index = i; generation++; pendingSeek = Math.max(0, time);
    const chapter = currentBook.chapters[i];
    saved.lastBook = currentBook.id;
    saved.progress[currentBook.id] = {chapterId: chapter.id, time: pendingSeek, completed: false};
    persist();
    audio.defaultPlaybackRate = Number($('speed').value);
    audio.src = chapter.url; audio.playbackRate = audio.defaultPlaybackRate;
    $('book-title').textContent = currentBook.title;
    $('chapter-title').textContent = chapter.title;
    $('elapsed').textContent = format(time); $('duration').textContent = '0:00'; $('seek').value = 0;
    $('save-status').textContent = time ? '从 ' + format(time) + ' 继续听' : '进度保存在当前浏览器。';
    status(autoplay ? '正在加载音频…' : time ? '已找到上次进度，点击继续听。' : '准备好了，点击播放。');
    updateControls(); renderChapters(); renderBooks(); updateMedia();
    if (autoplay) play();
}
function play() {
    if (!currentBook || index < 0) return;
    if (checkTimer()) return;
    try { if ('audioSession' in navigator) navigator.audioSession.type = 'playback'; } catch {}
    const version = generation;
    audio.play().catch(error => {
        if (version !== generation || error.name === 'AbortError') return;
        status(error.name === 'NotAllowedError' ? '请点播放按钮继续。' : '音频无法播放，请检查连接或换用 MP3 / M4A。');
        updateControls();
    });
}
function updateControls() {
    const ready = !!currentBook && index >= 0;
    $('play').disabled = $('back').disabled = $('forward').disabled = !ready;
    $('prev').disabled = !ready || index === 0;
    $('next').disabled = !ready || index >= currentBook.chapters.length-1;
    $('seek').disabled = !ready || !Number.isFinite(audio.duration);
    $('play').textContent = audio.paused ? '▶' : 'Ⅱ'; $('play').setAttribute('aria-label', audio.paused ? '播放' : '暂停');
    try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing'; } catch {}
}
function seekTo(time) {
    if (!Number.isFinite(audio.duration) || pendingSeek !== null) return;
    audio.currentTime = Math.max(0, Math.min(time, audio.duration)); saveProgress(true); updatePosition();
}
function updatePosition() {
    $('elapsed').textContent = format(audio.currentTime); $('duration').textContent = format(audio.duration);
    if (document.activeElement !== $('seek')) $('seek').value = Number.isFinite(audio.duration) && audio.duration ? audio.currentTime / audio.duration * 100 : 0;
    try {
        if (navigator.mediaSession?.setPositionState && Number.isFinite(audio.duration) && audio.duration > 0) navigator.mediaSession.setPositionState({duration: audio.duration, playbackRate: audio.playbackRate, position: Math.min(audio.currentTime, audio.duration)});
    } catch {}
}
function updateMedia() {
    if (!('mediaSession' in navigator) || !currentBook || typeof MediaMetadata === 'undefined') return;
    navigator.mediaSession.metadata = new MediaMetadata({title: currentBook.chapters[index].title, artist: currentBook.title, album: 'playRecap · 私人听书', artwork: [{src: new URL('/icon.svg', location.href).href, sizes:'128x128', type:'image/svg+xml'}]});
}
const mediaActions = {play, pause: () => audio.pause(), previoustrack: () => selectChapter(index-1), nexttrack: () => selectChapter(index+1), seekbackward: d => seekTo(audio.currentTime-(d.seekOffset || 15)), seekforward: d => seekTo(audio.currentTime+(d.seekOffset || 15)), seekto: d => seekTo(d.seekTime)};
if ('mediaSession' in navigator) for (const [action, handler] of Object.entries(mediaActions)) { try { navigator.mediaSession.setActionHandler(action, handler); } catch {} }
audio.addEventListener('loadedmetadata', () => {
    if (pendingSeek !== null) {
        const time = Number.isFinite(audio.duration) ? Math.min(pendingSeek, Math.max(0,audio.duration-.25)) : pendingSeek;
        audio.currentTime = time; pendingSeek = null;
    }
    updateControls(); updatePosition();
});
audio.addEventListener('playing', () => { if (!checkTimer()) status('正在播放'); updateControls(); });
audio.addEventListener('play', updateControls);
audio.addEventListener('pause', () => { saveProgress(true); updateControls(); if (!audio.ended) status('已暂停'); });
audio.addEventListener('waiting', () => { if (!audio.paused) status('正在缓冲…'); });
audio.addEventListener('error', () => { status('音频加载失败。请检查网络或文件，点击播放重试。'); updateControls(); });
audio.addEventListener('timeupdate', () => { checkTimer(); saveProgress(); updatePosition(); });
audio.addEventListener('ended', () => {
    saveProgress(true);
    if (checkTimer()) return;
    if (stopAfterChapter) { stopAfterChapter = false; $('timer').value = '0'; $('timer-status').textContent = '本章结束，晚安。'; status('本章已听完'); updateControls(); return; }
    if (index+1 < currentBook.chapters.length) selectChapter(index+1);
    else { status('这本书听完了。'); updateControls(); renderBooks(); }
});
function checkTimer() {
    if (deadline && Date.now() >= deadline) {
        deadline = 0; audio.pause(); saveProgress(true); $('timer').value = '0'; $('timer-status').textContent = '时间到了，晚安。'; status('睡眠定时已暂停播放'); return true;
    }
    return false;
}
$('timer').addEventListener('change', () => {
    stopAfterChapter = $('timer').value === 'chapter';
    deadline = !stopAfterChapter && Number($('timer').value) > 0 ? Date.now() + Number($('timer').value)*60000 : 0;
    $('timer-status').textContent = stopAfterChapter ? '本章结束后停止。' : deadline ? `将在 ${new Date(deadline).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})} 停止` : '不赶时间，慢慢听。';
});
setInterval(checkTimer, 1000);
$('speed').value = ['0.75','1','1.25','1.5','2'].includes(String(saved.speed)) ? String(saved.speed) : '1';
$('speed').addEventListener('change', () => { audio.defaultPlaybackRate = Number($('speed').value); audio.playbackRate = audio.defaultPlaybackRate; saved.speed = audio.playbackRate; persist(); updatePosition(); });
$('play').addEventListener('click', () => audio.paused ? play() : audio.pause());
$('prev').addEventListener('click', () => selectChapter(index-1)); $('next').addEventListener('click', () => selectChapter(index+1));
$('back').addEventListener('click', () => seekTo(audio.currentTime-15)); $('forward').addEventListener('click', () => seekTo(audio.currentTime+15));
$('seek').addEventListener('input', () => { $('elapsed').textContent = format(Number($('seek').value)*audio.duration/100); });
$('seek').addEventListener('change', () => seekTo(Number($('seek').value)*audio.duration/100));
window.addEventListener('pagehide', () => saveProgress(true));
document.addEventListener('visibilitychange', () => { checkTimer(); saveProgress(true); });
$('refresh').addEventListener('click', () => refresh().catch(e => notice(e.message)));
$('login-form').addEventListener('submit', async e => {
    e.preventDefault(); $('login-status').textContent = '正在进入…';
    try { await api('/api/login', {code: $('code').value}); $('code').value = ''; $('login-status').textContent = ''; await refresh(); }
    catch (e) { $('login-status').textContent = e.message; }
});
$('logout').addEventListener('click', async () => {
    audio.pause(); saveProgress(true);
    try { await api('/api/logout', {}); audio.removeAttribute('src'); audio.load(); currentBook = null; index = -1; showLogin(); }
    catch (e) { notice(e.message); }
});
function openImport() { $('import-dialog').showModal(); }
$('add-btn').addEventListener('click', openImport); $('empty-add').addEventListener('click', openImport);
$('close-import').addEventListener('click', () => { if (!uploading) $('import-dialog').close(); });
$('import-dialog').addEventListener('cancel', e => { if (uploading) e.preventDefault(); });
$('files').addEventListener('change', () => {
    const files = [...$('files').files].sort((a,b) => a.name.localeCompare(b.name, 'zh-CN', {numeric:true}));
    $('file-list').textContent = files.length ? `${files.length} 个文件 · ${(files.reduce((s,f) => s+f.size,0)/1024/1024).toFixed(1)} MB\n` + files.map(f => f.name).join('\n') : '请选择音频文件。';
});
function upload(file, book, progress) {
    return new Promise((resolve,reject) => {
        const xhr = new XMLHttpRequest(); xhr.open('POST','/api/upload');
        xhr.setRequestHeader('X-Recap-Request','1'); xhr.setRequestHeader('X-Book-Name',encodeURIComponent(book)); xhr.setRequestHeader('X-File-Name',encodeURIComponent(file.name));
        xhr.upload.onprogress = e => { if (e.lengthComputable) progress(e.loaded/e.total); };
        xhr.onload = () => {
            let response = {}; try { response = JSON.parse(xhr.responseText); } catch {}
            if (xhr.status >= 200 && xhr.status < 300) resolve();
            else reject(new Error(response.error || '上传失败，请重试。'));
        };
        xhr.onerror = () => reject(new Error('网络中断。已上传的章节会保留，请重试剩余文件。'));
        xhr.send(file);
    });
}
$('import-form').addEventListener('submit', async e => {
    e.preventDefault(); if (uploading) return;
    const files = [...$('files').files].sort((a,b) => a.name.localeCompare(b.name, 'zh-CN', {numeric:true}));
    const book = $('book-name').value.trim(); if (!files.length || !book) return;
    uploading = true; $('upload-btn').disabled = $('close-import').disabled = true;
    $('upload-progress').hidden = false; $('upload-progress').value = 0;
    let done = 0; const failed = [];
    for (const file of files) {
        $('upload-status').textContent = `正在导入 ${done+failed.length+1}/${files.length} · ${file.name}`;
        try { await upload(file, book, ratio => $('upload-progress').value = (done+failed.length+ratio)/files.length*100); done++; }
        catch (e) { failed.push(`${file.name}：${e.message}`); }
    }
    uploading = false; $('upload-btn').disabled = $('close-import').disabled = false;
    $('upload-progress').value = 100;
    $('upload-status').textContent = `已导入 ${done} 章。` + (failed.length ? failed.join('；') : '可以开始听了。');
    try { await refresh(); } catch(e) { notice(e.message); }
    if (!failed.length) { $('import-form').reset(); $('import-dialog').close(); notice(`《${book}》已导入 ${done} 章。`); }
});
api('/api/session').then(s => s.authenticated ? refresh() : showLogin()).catch(() => { showLogin(); $('login-status').textContent = '连接不到书库，请确认服务已启动。'; });
