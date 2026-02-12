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
    if (lastSavedState && lastSavedState.videoId) {
        console.log("Restoring state:", lastSavedState);
        statusTextEl.textContent = "Resuming session...";
        
        // This is the prompt way: queue the specific video from the playlist
        // Note: loadVideoById with list argument keeps the playlist context
        player.loadVideoById({
            videoId: lastSavedState.videoId,
            startSeconds: lastSavedState.currentTime,
            list: PLAYLIST_ID,
            listType: 'playlist', 
            // index: lastSavedState.index // Optional, if we tracked it accurately
        });
        
        // Auto-play is restricted on some mobile browsers without user interaction.
        // If it fails, the user will just hit play.
    } else {
        // New session, cue playlist
        player.cuePlaylist({list: PLAYLIST_ID});
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

// --- 4. Utilities ---

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
