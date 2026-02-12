// Config
const PLAYLIST_ID = 'PLAgb-eU_m17juOnwmvXoiQjwZi4KehKZs';
const STORAGE_KEY = 'sleep_audio_player_state';
const SAVE_INTERVAL_MS = 5000;

// State
let player;
let isReady = false;
let autoSaveInterval;
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
        list: PLAYLIST_ID,
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
            list: PLAYLIST_ID,
            listType: 'playlist',
            index: lastSavedState.index,
            startSeconds: lastSavedState.currentTime
        });
    } else {
        // New session, cue playlist
        player.cuePlaylist({ list: PLAYLIST_ID });
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

            localStorage.setItem(STORAGE_KEY, JSON.stringify(stateToSave));
            lastSavedState = stateToSave;
            updateSaveStatus(`Saved at ${formatTime(currentTime)}`);
        }
    }
}

function loadState() {
    const raw = localStorage.getItem(STORAGE_KEY);
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

const TOTAL_EPISODES = 150; // Hardcoded based on user info
const playlistDrawer = document.getElementById('playlist-drawer');
const playlistItemsContainer = document.getElementById('playlist-items');
const playlistToggleBtn = document.getElementById('playlist-toggle-btn');
const closeDrawerBtn = document.getElementById('close-drawer-btn');

// Initialize UI
renderPlaylist();

playlistToggleBtn.addEventListener('click', () => {
    playlistDrawer.classList.add('open');
    scrollToActiveItem();
});

closeDrawerBtn.addEventListener('click', () => {
    playlistDrawer.classList.remove('open');
});

function renderPlaylist() {
    playlistItemsContainer.innerHTML = '';

    // We don't have titles, so we generate generic ones.
    // However, if we've played them, we might have cached titles (future improvement)

    for (let i = 0; i < TOTAL_EPISODES; i++) {
        const item = document.createElement('div');
        item.className = 'playlist-item';
        item.dataset.index = i;
        item.innerHTML = `
            <span class="playlist-item-index">${i + 1}</span>
            <span class="playlist-item-title">Episode ${i + 1} (Click to Play)</span>
        `;

        item.addEventListener('click', () => {
            playIndex(i);
            playlistDrawer.classList.remove('open');
        });

        playlistItemsContainer.appendChild(item);
    }
}

function playIndex(index) {
    if (player && index >= 0 && index < TOTAL_EPISODES) {
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
