// Config
// Default to the original playlist if none saved
let currentPlaylistId = localStorage.getItem('last_playlist_id') || 'PLAgb-eU_m17juOnwmvXoiQjwZi4KehKZs';
const STORAGE_PREFIX = 'sleep_player_';
const SAVE_INTERVAL_MS = 5000;

// State
let player;
let isReady = false;
let autoSaveInterval;
let sleepTimer = null;
let lastSavedState = loadState();

// DOM Elements
const titleEl = document.getElementById('video-title');
const statusTextEl = document.getElementById('status-text');
const playPauseBtn = document.getElementById('play-pause-btn');
const prevBtn = document.getElementById('prev-btn');
const nextBtn = document.getElementById('next-btn');
const saveStatusEl = document.getElementById('save-status');
const silentPlayer = document.getElementById('ios-silent-player');

// --- 1. YouTube API Initialization ---
function onYouTubeIframeAPIReady() {
    console.log("API Ready");

    // Determine start parameters
    let playerVars = {
        listType: 'playlist',
        list: currentPlaylistId,
        playsinline: 1, // Important for iOS to not fullscreen automatically
    };

    // If we have a saved state, we might try to start there,
    // but the API is tricky with playlists + start time on init.
    // Strategy: Init player, wait for ready, then seek/cue.

    player = new YT.Player('player', {
        height: '100%',
        width: '100%',
        playerVars: playerVars,
        events: {
            'onReady': onPlayerReady,
            'onStateChange': onPlayerStateChange,
            'onError': onPlayerError
        }
    });
}

function onPlayerReady(event) {
    isReady = true;
    titleEl.textContent = "Player Ready";
    updateSaveStatus("Ready to load previous session...");

    // Basic controls
    playPauseBtn.addEventListener('click', togglePlay);
    prevBtn.addEventListener('click', () => player.previousVideo());
    nextBtn.addEventListener('click', () => player.nextVideo());

    // Restore state if exists
    if (lastSavedState && lastSavedState.index !== undefined) {
        console.log("Restoring state:", lastSavedState);
        statusTextEl.textContent = "Resuming session...";

        // Use loadPlaylist to ensure the playlist context is preserved for auto-next
        player.loadPlaylist({
            list: currentPlaylistId,
            listType: 'playlist',
            index: lastSavedState.index,
            startSeconds: lastSavedState.currentTime
        });
    } else {
        // New session, cue playlist
        player.cuePlaylist({ list: currentPlaylistId });
    }

    // Start auto-save loop
    autoSaveInterval = setInterval(saveCurrentState, SAVE_INTERVAL_MS);
}

function onPlayerStateChange(event) {
    // Update Play/Pause Button Icon
    if (event.data == YT.PlayerState.PLAYING) {
        playPauseBtn.textContent = "⏸";
        statusTextEl.textContent = "Playing";
        updateVideoTitle();
        updateMediaSession(); // Update lock screen info

        // Update Playlist UI
        const index = player.getPlaylistIndex();
        highlightActiveItem(index);

        // Dynamically update playlist length & re-render if needed
        const playlist = player.getPlaylist();
        if (playlist && playlist.length !== totalVideos) {
            totalVideos = playlist.length;
            renderPlaylist();
            highlightActiveItem(index); // re-highlight after re-render
        }

        // iOS Hack: Keep silent audio playing to maintain session
        if (silentPlayer) silentPlayer.play().catch(e => console.log("Silent play failed", e));

        // Reset switching flag as we are strictly playing the new video now
        isSwitching = false;

    } else if (event.data == YT.PlayerState.ENDED) {
        playPauseBtn.textContent = "▶";
        statusTextEl.textContent = "Playback Ended";
    } else if (event.data == YT.PlayerState.BUFFERING) {
        statusTextEl.textContent = "Buffering...";
    } else if (event.data == YT.PlayerState.CUED) {
        playPauseBtn.textContent = "▶";
        statusTextEl.textContent = "Ready";
        isSwitching = false; // Also reset here as cued means playlist loaded

        // Update playlist length on cue as well
        const playlist = player.getPlaylist();
        if (playlist && playlist.length !== totalVideos) {
            totalVideos = playlist.length;
            renderPlaylist();
        }
    } else if (event.data == YT.PlayerState.PAUSED) {
        playPauseBtn.textContent = "▶";
        statusTextEl.textContent = "Paused";
        saveCurrentState();
    } else {
        // UNSTARTED (-1) or unknown
        playPauseBtn.textContent = "▶";
        statusTextEl.textContent = "Not Started";
    }
}

function onPlayerError(event) {
    console.error("Player Error:", event.data);
    statusTextEl.textContent = "Error occurred. Try reloading.";
    // Reset switching flag so saveCurrentState is not permanently blocked
    isSwitching = false;
}

// --- 2. Action Logic ---

function togglePlay() {
    if (!isReady) return;
    const state = player.getPlayerState();
    if (state === YT.PlayerState.PLAYING) {
        player.pauseVideo();
    } else {
        player.playVideo();
    }
}

function updateVideoTitle() {
    if (player && player.getVideoData) {
        const data = player.getVideoData();
        if (data && data.title) {
            titleEl.textContent = data.title;
        }
    }
}

let isSwitching = false;

// --- 3. State Management ---

function saveCurrentState() {
    if (!isReady || !player || isSwitching) return;

    // Only save if playing or paused (avoid buffering/unstarted mess)
    const state = player.getPlayerState();
    if (state === YT.PlayerState.PLAYING || state === YT.PlayerState.PAUSED) {
        const currentTime = player.getCurrentTime();
        const videoData = player.getVideoData();
        const playlistIndex = player.getPlaylistIndex();

        if (videoData && videoData.video_id) {
            const stateToSave = {
                videoId: videoData.video_id,
                title: videoData.title,
                currentTime: currentTime,
                index: playlistIndex,
                timestamp: Date.now()
            };

            // Save with dynamic key based on current playlist
            localStorage.setItem(STORAGE_PREFIX + currentPlaylistId, JSON.stringify(stateToSave));

            // Also save the "last used playlist"
            localStorage.setItem('last_playlist_id', currentPlaylistId);

            lastSavedState = stateToSave;
            updateSaveStatus(`Saved at ${formatTime(currentTime)}`);
        }
    }
}

function loadState() {
    const raw = localStorage.getItem(STORAGE_PREFIX + currentPlaylistId);
    if (raw) {
        try {
            return JSON.parse(raw);
        } catch (e) {
            console.error("Failed to parse saved state", e);
            return null;
        }
    }
    return null;
}

// --- 4. Media Session API (Lock Screen Controls) ---

function updateMediaSession() {
    if ('mediaSession' in navigator && player) {
        const videoData = player.getVideoData();
        if (!videoData) return;

        navigator.mediaSession.metadata = new MediaMetadata({
            title: videoData.title || 'Sleep Audio',
            artist: videoData.author || 'YouTube',
            artwork: [
                { src: `https://img.youtube.com/vi/${videoData.video_id}/mqdefault.jpg`, sizes: '320x180', type: 'image/jpeg' }
            ]
        });

        navigator.mediaSession.setActionHandler('play', () => {
            if (silentPlayer) silentPlayer.play().catch(e => console.error(e));
            player.playVideo();
        });
        navigator.mediaSession.setActionHandler('pause', () => {
            if (silentPlayer) silentPlayer.pause();
            player.pauseVideo();
        });
        navigator.mediaSession.setActionHandler('previoustrack', () => {
            player.previousVideo();
        });
        navigator.mediaSession.setActionHandler('nexttrack', () => {
            player.nextVideo();
        });

        // Seek Handlers
        navigator.mediaSession.setActionHandler('seekto', (details) => {
            if (details.seekTime && !isNaN(details.seekTime)) {
                player.seekTo(details.seekTime, true);
            }
        });
        navigator.mediaSession.setActionHandler('seekbackward', (details) => {
            const skipTime = details.seekOffset || 10;
            const currentTime = player.getCurrentTime();
            player.seekTo(Math.max(currentTime - skipTime, 0), true);
        });
        navigator.mediaSession.setActionHandler('seekforward', (details) => {
            const skipTime = details.seekOffset || 10;
            const currentTime = player.getCurrentTime();
            const duration = player.getDuration();
            player.seekTo(Math.min(currentTime + skipTime, duration), true);
        });
    }
}

// --- 5. Utilities ---

function updateSaveStatus(msg) {
    const now = new Date();
    const timeString = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    saveStatusEl.textContent = `${msg} (${timeString})`;
}

function formatTime(seconds) {
    const min = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60);
    return `${min}:${sec < 10 ? '0' : ''}${sec}`;
}

// --- 6. Playlist UI Logic ---

// Note: TOTAL_EPISODES is tricky with dynamic playlists.
// Ideally, we'd fetch the length. For now, we'll assume a standard size or try to detect.
let totalVideos = 150;

const playlistDrawer = document.getElementById('playlist-drawer');
const playlistItemsContainer = document.getElementById('playlist-items');
const playlistToggleBtn = document.getElementById('playlist-toggle-btn');
const closeDrawerBtn = document.getElementById('close-drawer-btn');

// Settings UI — iOS Bottom Sheet
const settingsSheet = document.getElementById('settings-sheet');
const sheetBackdrop = document.getElementById('sheet-backdrop');
const settingsToggleBtn = document.getElementById('settings-toggle-btn');
const playlistInput = document.getElementById('playlist-input');
const playlistNameInput = document.getElementById('playlist-name-input');
const addPlaylistBtn = document.getElementById('add-playlist-btn');
const libraryListContainer = document.getElementById('library-list');
const timerBtns = document.querySelectorAll('.timer-btn');
const timerStatusEl = document.getElementById('timer-status');
const sheetTabs = document.querySelectorAll('.sheet-tab');

// Initialize UI
renderPlaylist();
renderLibrary();

// Open / Close Sheet
function openSheet() {
    settingsSheet.classList.add('open');
    sheetBackdrop.classList.add('visible');
    renderLibrary();
}

function closeSheet() {
    settingsSheet.classList.remove('open');
    sheetBackdrop.classList.remove('visible');
}

settingsToggleBtn.addEventListener('click', openSheet);
sheetBackdrop.addEventListener('click', closeSheet);

// Tab Switching
sheetTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        const targetId = 'tab-' + tab.dataset.tab;

        // Toggle active tab
        sheetTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        // Toggle bodies
        document.querySelectorAll('.sheet-body').forEach(body => body.classList.add('hidden'));
        document.getElementById(targetId).classList.remove('hidden');
    });
});

// Event Listeners for UI
playlistToggleBtn.addEventListener('click', () => {
    playlistDrawer.classList.add('open');
    scrollToActiveItem();
});

closeDrawerBtn.addEventListener('click', () => {
    playlistDrawer.classList.remove('open');
});

addPlaylistBtn.addEventListener('click', () => {
    const urlOrId = playlistInput.value.trim();
    const name = playlistNameInput.value.trim() || 'Untitled Book';

    if (!urlOrId) return;

    let newId = urlOrId;
    if (urlOrId.includes('list=')) {
        newId = urlOrId.split('list=')[1].split('&')[0];
    }

    addToLibrary(newId, name);
    playlistInput.value = '';
    playlistNameInput.value = '';
    renderLibrary();
});

timerBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        const mins = parseInt(btn.dataset.time);
        setSleepTimer(mins);

        // Update UI
        timerBtns.forEach(b => b.classList.remove('active'));
        if (mins > 0) btn.classList.add('active');
        else timerBtns.forEach(b => b.classList.remove('active'));
    });
});

// --- Library Logic ---

function getLibrary() {
    try {
        return JSON.parse(localStorage.getItem('my_library') || '[]');
    } catch {
        return [];
    }
}

function addToLibrary(id, name) {
    const library = getLibrary();
    // Check if exists
    if (!library.find(b => b.id === id)) {
        library.push({ id, name, addedAt: Date.now() });
        localStorage.setItem('my_library', JSON.stringify(library));
    } else {
        alert('Book already in library!');
    }
}

function removeFromLibrary(id) {
    let library = getLibrary();
    library = library.filter(b => b.id !== id);
    localStorage.setItem('my_library', JSON.stringify(library));
    renderLibrary();
}

function renderLibrary() {
    const library = getLibrary();
    libraryListContainer.innerHTML = '';

    if (library.length === 0) {
        libraryListContainer.innerHTML = '<div class="empty-state">No saved books yet.<br>Add your first book below!</div>';
        return;
    }

    library.forEach(book => {
        const item = document.createElement('div');
        item.className = 'library-item';
        if (book.id === currentPlaylistId) item.classList.add('active');

        const isPlaying = book.id === currentPlaylistId;

        item.innerHTML = `
            <div class="library-item-content">
                <span class="book-title">${book.name}</span>
                ${isPlaying ? '<span class="now-playing">▶ Now Playing</span>' : '<span class="book-progress">Tap to play</span>'}
            </div>
            <button class="delete-btn">✕</button>
        `;

        // Click on content -> Switch
        item.querySelector('.library-item-content').addEventListener('click', () => {
            if (book.id !== currentPlaylistId) {
                switchPlaylist(book.id);
                renderLibrary(); // Update UI before closing to reflect new "Now Playing"
                closeSheet();
            }
        });

        // Click delete
        item.querySelector('.delete-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm(`Remove "${book.name}"?`)) {
                removeFromLibrary(book.id);
            }
        });

        libraryListContainer.appendChild(item);
    });
}


function switchPlaylist(newId) {
    console.log("Switching playlist to:", newId);

    // 1. Save current state of the OLD playlist before switching
    saveCurrentState();

    // 2. Set switching flag to prevent state corruption during transition
    isSwitching = true;

    // 3. Update ID
    currentPlaylistId = newId;
    localStorage.setItem('last_playlist_id', newId);

    // 4. Load saved state for the NEW playlist
    lastSavedState = loadState();

    // 5. Load the new playlist
    if (player && player.loadPlaylist) {
        if (lastSavedState && lastSavedState.index !== undefined) {
            player.loadPlaylist({
                list: currentPlaylistId,
                listType: 'playlist',
                index: lastSavedState.index,
                startSeconds: lastSavedState.currentTime
            });
        } else {
            player.cuePlaylist({
                list: newId,
                listType: 'playlist'
            });
            // Auto-play after cue (with delay to ensure API processes cue)
            setTimeout(() => {
                if (player && typeof player.playVideo === 'function') {
                    player.playVideo();
                }
            }, 500);
        }
        statusTextEl.textContent = "Loading Playlist...";
        titleEl.textContent = "Please wait...";

        // Reset totalVideos; will be updated dynamically when playlist loads
        totalVideos = 0;

        // Force stop to clear previous video state and prevent data pollution
        if (player && typeof player.stopVideo === 'function') {
            player.stopVideo();
        }

        renderPlaylist();

        // Safety timeout: reset isSwitching after 15s in case playlist never loads
        setTimeout(() => {
            if (isSwitching) {
                console.warn("switchPlaylist timeout: resetting isSwitching flag");
                isSwitching = false;
            }
        }, 15000);
    } else {
        location.reload();
    }
}

function setSleepTimer(minutes) {
    if (sleepTimer) clearTimeout(sleepTimer);

    if (minutes === 0) {
        timerStatusEl.textContent = "Timer: Off";
        return;
    }

    timerStatusEl.textContent = `Timer: Pausing in ${minutes}m`;

    sleepTimer = setTimeout(() => {
        if (player) {
            player.pauseVideo();
            timerStatusEl.textContent = "Timer: Ended (Paused)";
            timerBtns.forEach(b => b.classList.remove('active')); // Reset UI
        }
    }, minutes * 60 * 1000);
}

function renderPlaylist() {
    playlistItemsContainer.innerHTML = '';

    // We don't have titles, so we generate generic ones.
    for (let i = 0; i < totalVideos; i++) {
        const item = document.createElement('div');
        item.className = 'playlist-item';
        item.dataset.index = i;
        item.innerHTML = `
            <span class="playlist-item-index">${i + 1}</span>
            <span class="playlist-item-title">Episode ${i + 1}</span>
        `;

        item.addEventListener('click', () => {
            playIndex(i);
            playlistDrawer.classList.remove('open');
        });

        playlistItemsContainer.appendChild(item);
    }
}

function playIndex(index) {
    if (player && index >= 0) { // Removed strict upper bound check as dynamic lists vary
        player.playVideoAt(index);
    }
}

function highlightActiveItem(index) {
    // Remove active class from all
    document.querySelectorAll('.playlist-item').forEach(el => el.classList.remove('active'));

    // Add to current
    const activeItem = playlistItemsContainer.children[index];
    if (activeItem) {
        activeItem.classList.add('active');
    }
}

function scrollToActiveItem() {
    const activeItem = document.querySelector('.playlist-item.active');
    if (activeItem) {
        activeItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

