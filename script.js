// script.js

let audioPlayer;
let currentInfoDisplay;
let playlistDisplay;

let schedule = []; // Stores parsed CSV data with calculated start times
let currentPlayIndex = -1; // Index of the currently playing item in the schedule

// 硬编码基础 URL，根据您的 GitHub Pages 路径设置
const RADIO_BASE_URL = 'https://raw.githubusercontent.com/rrrrnr/web-radio/refs/heads/main/';
const AUDIO_FILES_BASE_URL = RADIO_BASE_URL + 'audio/'; // 音频文件所在的子目录

// This variable will hold the start time of the "broadcast" based on the first item in the schedule.
// This is crucial for synchronizing playback with absolute time.
let radioStartTime = null;

document.addEventListener('DOMContentLoaded', initApp);

function initApp() {
    audioPlayer = document.getElementById('audioPlayer');
    currentInfoDisplay = document.getElementById('current-info');
    playlistDisplay = document.getElementById('playlist');

    audioPlayer.addEventListener('ended', playNextAudio);
    audioPlayer.addEventListener('play', updateCurrentInfo);
    audioPlayer.addEventListener('pause', updateCurrentInfo);
    audioPlayer.addEventListener('error', handleAudioError);
    audioPlayer.addEventListener('canplay', handleCanPlay);

    playlistDisplay.innerHTML = 'Loading radio schedule...';
    currentInfoDisplay.innerHTML = 'Loading radio schedule...';

    // 页面加载后自动加载 CSV
    loadCsvSchedule();
}

async function loadCsvSchedule() {
    currentInfoDisplay.innerHTML = 'Loading CSV schedule...';
    playlistDisplay.innerHTML = 'Loading...';

    // Assume table.csv is in the RADIO_BASE_URL
    const csvUrl = RADIO_BASE_URL + 'table.csv';

    try {
        const response = await fetch(csvUrl);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const csvText = await response.text();

        Papa.parse(csvText, {
            header: true,
            dynamicTyping: false,
            complete: function(results) {
                // Filter out rows with missing data and parse time
                schedule = results.data.filter(row => row.time && row.file)
                                       .map(row => {
                                           const dtString = String(row.time); // Ensure it's a string
                                           // Parse YYYYMMDDHHmmss string to Date object
                                           const year = parseInt(dtString.substring(0, 4));
                                           const month = parseInt(dtString.substring(4, 6)) - 1; // Month is 0-indexed
                                           const day = parseInt(dtString.substring(6, 8));
                                           const hour = parseInt(dtString.substring(8, 10));
                                           const minute = parseInt(dtString.substring(10, 12));
                                           const second = parseInt(dtString.substring(12, 14));
                                           return {
                                               time: new Date(year, month, day, hour, minute, second),
                                               file: row.file,
                                               url: AUDIO_FILES_BASE_URL + row.file, // Construct full URL using hardcoded path
                                               duration: 0 // Will be set after metadata is loaded
                                           };
                                       });

                // Sort by time to ensure correct playback order
                schedule.sort((a, b) => a.time.getTime() - b.time.getTime());

                // Set the radio's "start time" to the timestamp of the very first audio file
                if (schedule.length > 0) {
                    radioStartTime = schedule[0].time;
                    console.log('Radio broadcast starts at:', radioStartTime.toLocaleString());
                } else {
                    radioStartTime = null;
                }

                console.log('Parsed CSV schedule with URLs:', schedule);
                displayPlaylist();
                currentInfoDisplay.innerHTML = 'CSV schedule loaded. Determining current position...';

                // Preload durations for better seeking/synchronization
                preloadAudioDurations();
            },
            error: function(err) {
                console.error("Error parsing CSV:", err);
                currentInfoDisplay.innerHTML = 'Error loading CSV. Please check the file format or URL.';
            }
        });
    } catch (error) {
        console.error("Failed to fetch CSV:", error);
        currentInfoDisplay.innerHTML = `Failed to fetch CSV: ${error.message}. Make sure 'table.csv' is accessible at ${csvUrl}.`;
    }
}

async function preloadAudioDurations() {
    let loadedCount = 0;
    for (const item of schedule) {
        try {
            const tempAudio = new Audio();
            tempAudio.src = item.url;
            await new Promise((resolve, reject) => {
                tempAudio.addEventListener('loadedmetadata', () => {
                    item.duration = tempAudio.duration; // Store duration in seconds
                    console.log(`Loaded metadata for ${item.file}: ${item.duration}s`);
                    loadedCount++;
                    currentInfoDisplay.innerHTML = `Loading audio metadata: ${loadedCount}/${schedule.length} files...`;
                    resolve();
                }, { once: true });
                tempAudio.addEventListener('error', (e) => {
                    console.error(`Error loading metadata for ${item.file}:`, e);
                    currentInfoDisplay.innerHTML = `Error loading metadata for ${item.file}. See console.`;
                    item.duration = 0; // Mark as unplayable or 0 duration
                    resolve(); // Resolve to continue with other files
                }, { once: true });
                tempAudio.load();
            });
        } catch (error) {
            console.error(`Promise error for ${item.file}:`, error);
        }
    }
    console.log('All audio durations preloaded.');
    currentInfoDisplay.innerHTML = 'All audio metadata loaded. Attempting to synchronize playback.';
    synchronizePlayback();
}


function displayPlaylist() {
    playlistDisplay.innerHTML = ''; // Clear previous playlist
    if (schedule.length === 0) {
        playlistDisplay.innerHTML = 'No valid data in CSV to display playlist.';
        return;
    }

    schedule.forEach((item, index) => {
        const div = document.createElement('div');
        div.classList.add('playlist-item');
        div.dataset.index = index;
        div.textContent = `${formatDateTime(item.time)}: ${item.file} (Duration: ${item.duration ? formatTime(item.duration) : 'Loading...'})`;
        playlistDisplay.appendChild(div);

        // Add click listener to jump to a specific track
        div.addEventListener('click', () => {
            if (item.url) {
                currentPlayIndex = index;
                audioPlayer.src = item.url;
                audioPlayer.currentTime = 0; // Start from beginning of this track when clicked
                audioPlayer.play();
                highlightPlaylistItem(currentPlayIndex);
                currentInfoDisplay.innerHTML = `Manually playing: ${item.file}`;
            } else {
                alert(`Audio URL for "${item.file}" not available.`);
            }
        });
    });
}

function synchronizePlayback() {
    if (!radioStartTime || schedule.length === 0) {
        currentInfoDisplay.innerHTML = 'Radio schedule not ready for synchronization.';
        return;
    }

    const now = new Date();
    // Calculate total elapsed time since radio start
    const elapsedSecondsSinceRadioStart = (now.getTime() - radioStartTime.getTime()) / 1000;

    let foundIndex = -1;
    let seekTimeInCurrentTrack = 0;
    let cumulativeOffset = 0; // Keep track of the total duration of tracks before the current one

    for (let i = 0; i < schedule.length; i++) {
        const item = schedule[i];
        if (item.duration === 0) {
            console.warn(`Skipping ${item.file} due to unknown duration.`);
            continue;
        }

        // Calculate the absolute start time (in seconds from radioStartTime) for this item
        const itemStartTimeRelative = (item.time.getTime() - radioStartTime.getTime()) / 1000;

        // Check if the current elapsed time falls within this track's absolute time slot
        if (elapsedSecondsSinceRadioStart >= itemStartTimeRelative &&
            elapsedSecondsSinceRadioStart < (itemStartTimeRelative + item.duration)) {
            
            foundIndex = i;
            seekTimeInCurrentTrack = elapsedSecondsSinceRadioStart - itemStartTimeRelative;
            break;
        }
    }

    if (foundIndex !== -1) {
        currentPlayIndex = foundIndex;
        const currentItem = schedule[currentPlayIndex];
        audioPlayer.src = currentItem.url;
        audioPlayer.currentTime = seekTimeInCurrentTrack;
        audioPlayer.play().catch(error => {
            console.error("Autoplay failed:", error);
            currentInfoDisplay.innerHTML = `Autoplay blocked. Click play. Now scheduled: ${currentItem.file}`;
            // If autoplay is blocked, just load it and let the user click play
        });
        highlightPlaylistItem(currentPlayIndex);
        currentInfoDisplay.innerHTML = `Synchronized to: ${currentItem.file} at ${formatTime(seekTimeInCurrentTrack)}`;
    } else {
        // If elapsed time is before the first track or after the last track
        currentInfoDisplay.innerHTML = 'Not currently within any scheduled broadcast slot. Starting from beginning.';
        currentPlayIndex = 0; // Start from the first track
        if (schedule.length > 0 && schedule[0].url) {
            audioPlayer.src = schedule[0].url;
            audioPlayer.currentTime = 0;
            audioPlayer.play().catch(error => {
                console.error("Autoplay failed:", error);
                currentInfoDisplay.innerHTML = `Autoplay blocked. Click play. Starting: ${schedule[0].file}`;
            });
            highlightPlaylistItem(0);
        } else {
             currentInfoDisplay.innerHTML = 'No schedule or audio files to play.';
        }
    }
}


function playNextAudio() {
    currentPlayIndex++;
    if (currentPlayIndex < schedule.length) {
        const nextItem = schedule[currentPlayIndex];
        if (nextItem.url) {
            audioPlayer.src = nextItem.url;
            audioPlayer.load(); // Load the next audio
            audioPlayer.play().catch(error => {
                 console.warn("Autoplay of next track failed:", error);
                 currentInfoDisplay.innerHTML = `Autoplay blocked for ${nextItem.file}. Click play.`;
            });
            highlightPlaylistItem(currentPlayIndex);
            updateCurrentInfo();
        } else {
            console.error(`Next audio file URL missing for index ${currentPlayIndex}: ${nextItem.file}`);
            currentInfoDisplay.innerHTML = `Error: Cannot play next file (${nextItem.file}). URL missing. Trying next...`;
            // Skip this file if URL is missing
            playNextAudio();
        }
    } else {
        currentInfoDisplay.innerHTML = 'Radio broadcast finished.';
        currentPlayIndex = -1; // Reset
        highlightPlaylistItem(-1); // De-highlight all
    }
}

function updateCurrentInfo() {
    if (currentPlayIndex !== -1 && schedule[currentPlayIndex]) {
        const currentItem = schedule[currentPlayIndex];
        const currentTime = audioPlayer.currentTime;
        const duration = audioPlayer.duration;
        const progress = isNaN(currentTime) || isNaN(duration) ? '00:00 / 00:00' : `${formatTime(currentTime)} / ${formatTime(duration)}`;
        currentInfoDisplay.innerHTML = `Playing: ${currentItem.file} (${progress})`;
    } else if (!audioPlayer.paused) {
         currentInfoDisplay.innerHTML = 'Playing...';
    } else {
        currentInfoDisplay.innerHTML = 'Paused or Not playing.';
    }
}

function handleAudioError(e) {
    console.error("Audio error:", e);
    const errorMsg = audioPlayer.error ? audioPlayer.error.message : 'Unknown audio error.';
    currentInfoDisplay.innerHTML = `Audio playback error! (${errorMsg}). Check console for details. File: ${schedule[currentPlayIndex]?.file || 'N/A'}`;
    // Optionally try to play the next audio if there's an error
    // If the error happens during automatic playback (e.g., file not found), it's good to try the next one
    if (e.target.error.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED || e.target.error.code === MediaError.MEDIA_ERR_NETWORK) {
         console.warn("Attempting to play next audio due to error.");
         playNextAudio();
    }
}

function handleCanPlay() {
    // This event fires when enough data is available to play, but not necessarily enough to play to the end.
    // We can use this to update the duration in the playlist if it wasn't preloaded,
    // but the preloadAudioDurations is designed to handle this more comprehensively.
}

function highlightPlaylistItem(index) {
    const playlistItems = document.querySelectorAll('.playlist-item');
    playlistItems.forEach((item, idx) => {
        if (idx === index) {
            item.classList.add('active');
            item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } else {
            item.classList.remove('active');
        }
    });
}

// Helper function to format datetime for display
function formatDateTime(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// Helper function to format time (e.g., 65 seconds -> 01:05)
function formatTime(seconds) {
    if (isNaN(seconds) || seconds < 0) return '00:00';
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
}
