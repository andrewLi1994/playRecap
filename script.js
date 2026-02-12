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

        // iOS Hack: Keep silent audio playing to maintain session
        if (silentPlayer) silentPlayer.play().catch(e => console.log("Silent play failed", e));

    } else if (event.data == YT.PlayerState.ENDED) {
        statusTextEl.textContent = "Playback Ended";
        // Attempt to go to next video if it doesn't happen automatically
        // (Though loadPlaylist usually handles this)
        // player.nextVideo(); 
    } else {
        playPauseBtn.textContent = "▶";
        statusTextEl.textContent = "Paused";
        // Force save on pause (e.g. headphones unplugged)
        if (event.data == YT.PlayerState.PAUSED) {
            saveCurrentState();
        }
    }
}

function onPlayerError(event) {
    console.error("Player Error:", event.data);
    statusTextEl.textContent = "Error occurred. Try reloading.";
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

// --- 3. State Management ---

function saveCurrentState() {
    if (!isReady || !player) return;

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

// Settings UI
const settingsModal = document.getElementById('settings-modal');
const settingsToggleBtn = document.getElementById('settings-toggle-btn');
const closeSettingsBtn = document.getElementById('close-settings-btn');
const playlistInput = document.getElementById('playlist-input');
const loadPlaylistBtn = document.getElementById('load-playlist-btn');
const timerBtns = document.querySelectorAll('.timer-btn');
const timerStatusEl = document.getElementById('timer-status');

// Initialize UI
renderPlaylist();

// Event Listeners for UI
playlistToggleBtn.addEventListener('click', () => {
    playlistDrawer.classList.add('open');
    scrollToActiveItem();
});

closeDrawerBtn.addEventListener('click', () => {
    playlistDrawer.classList.remove('open');
});

settingsToggleBtn.addEventListener('click', () => {
    settingsModal.classList.add('visible');
    playlistInput.value = currentPlaylistId;
});

closeSettingsBtn.addEventListener('click', () => {
    settingsModal.classList.remove('visible');
});

loadPlaylistBtn.addEventListener('click', () => {
    const input = playlistInput.value.trim();
    let newId = input;

    // Extract ID if URL is pasted
    if (input.includes('list=')) {
        newId = input.split('list=')[1].split('&')[0];
    }

    if (newId && newId !== currentPlaylistId) {
        switchPlaylist(newId);
        settingsModal.classList.remove('visible');
    }
});

timerBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        const mins = parseInt(btn.dataset.time);
        setSleepTimer(mins);

        // Update UI
        timerBtns.forEach(b => b.classList.remove('active'));
        if (mins > 0) btn.classList.add('active');
    });
});

function switchPlaylist(newId) {
    console.log("Switching playlist to:", newId);
    currentPlaylistId = newId;
    localStorage.setItem('last_playlist_id', newId);

    // Reset state loading logic to look for the new key
    lastSavedState = loadState();

    // Create new player (or re-cue)
    // Simplest way is to re-cue if player exists
    if (player && player.cuePlaylist) {
        if (lastSavedState && lastSavedState.index !== undefined) {
            player.loadPlaylist({
                list: currentPlaylistId,
                listType: 'playlist',
                index: lastSavedState.index,
                startSeconds: lastSavedState.currentTime
            });
        } else {
            player.loadPlaylist({
                list: newId,
                listType: 'playlist'
            });
        }
        statusTextEl.textContent = "Playlist Loaded";
        titleEl.textContent = "Loading new book...";
        renderPlaylist(); // Re-render generic items (would be better with real titles)
    } else {
        location.reload(); // Fallback if player state is weird
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

// Hook into state change to update highlight
const originalOnPlayerStateChange = onPlayerStateChange;
// We already update UI in onPlayerStateChange, let's just add the hook there inside the function
// to avoid redefining. I'll modify existing onPlayerStateChange instead.
