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

// 预加载的触发时间点 (秒)
const PRELOAD_THRESHOLD_SECONDS = 30;
// 标记下一首是否已触发预加载，避免重复
let nextTrackPreloadTriggered = false;

document.addEventListener('DOMContentLoaded', initApp);

function initApp() {
    audioPlayer = document.getElementById('audioPlayer');
    currentInfoDisplay = document.getElementById('current-info');
    playlistDisplay = document.getElementById('playlist');

    audioPlayer.addEventListener('ended', playNextAudio);
    audioPlayer.addEventListener('play', updateCurrentInfo);
    audioPlayer.addEventListener('pause', updateCurrentInfo);
    audioPlayer.addEventListener('error', handleAudioError);
    // 监听 timeupdate 事件来检查是否需要预加载下一首
    audioPlayer.addEventListener('timeupdate', checkPreloadNextAudio);

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
                schedule = results.data.filter(row => row.time && row.file)
                                       .map(row => {
                                           const dtString = String(row.time);
                                           const year = parseInt(dtString.substring(0, 4));
                                           const month = parseInt(dtString.substring(4, 6)) - 1;
                                           const day = parseInt(dtString.substring(6, 8));
                                           const hour = parseInt(dtString.substring(8, 10));
                                           const minute = parseInt(dtString.substring(10, 12));
                                           const second = parseInt(dtString.substring(12, 14));
                                           return {
                                               time: new Date(year, month, day, hour, minute, second),
                                               file: row.file,
                                               url: AUDIO_FILES_BASE_URL + row.file,
                                               duration: 0, // 初始时长未知
                                               status: 'pending', // 'pending', 'metadata_loading', 'metadata_loaded', 'error'
                                               preloaded: false // 用于标记是否已预加载音频数据
                                           };
                                       });

                schedule.sort((a, b) => a.time.getTime() - b.time.getTime());

                if (schedule.length > 0) {
                    radioStartTime = schedule[0].time;
                    console.log('Radio broadcast starts at:', radioStartTime.toLocaleString());
                } else {
                    radioStartTime = null;
                }

                console.log('Parsed CSV schedule with URLs:', schedule);
                displayPlaylist();
                currentInfoDisplay.innerHTML = 'CSV schedule loaded. Attempting to synchronize playback.';
                
                // 直接尝试同步播放，会在需要时懒加载第一个音频的元数据
                synchronizePlayback();
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

// 新增函数：加载单个音频文件的元数据和时长
async function loadAudioMetadata(item) {
    if (item.status === 'metadata_loaded' || item.status === 'metadata_loading') {
        return item.duration;
    }
    item.status = 'metadata_loading';
    try {
        const tempAudio = new Audio();
        tempAudio.src = item.url;
        await new Promise((resolve) => {
            tempAudio.addEventListener('loadedmetadata', () => {
                item.duration = tempAudio.duration;
                item.status = 'metadata_loaded';
                console.log(`Metadata loaded for ${item.file}: ${item.duration}s`);
                resolve();
            }, { once: true });
            tempAudio.addEventListener('error', (e) => {
                console.error(`Error loading metadata for ${item.file}:`, e);
                item.duration = 0; // 标记为未知时长
                item.status = 'error';
                resolve(); // 即使出错也要 resolve，不阻塞后续流程
            }, { once: true });
            tempAudio.load(); // 仅加载元数据，不播放
        });
        return item.duration;
    } catch (error) {
        console.error(`Failed to load metadata for ${item.file}:`, error);
        item.duration = 0;
        item.status = 'error';
        return 0;
    }
}

// 新增函数：预加载下一个音频的二进制数据
// 这里的 preloader 不会播放音频，仅用于触发浏览器缓存
const audioPreloaders = new Map(); // 用于存储临时的 Audio 对象，避免被垃圾回收

function preloadAudioData(item) {
    if (item.preloaded || item.status === 'error' || !item.url) {
        return;
    }

    if (!audioPreloaders.has(item.file)) {
        console.log(`Preloading data for: ${item.file}`);
        const preloader = new Audio();
        preloader.src = item.url;
        preloader.preload = 'auto'; // 提示浏览器尽可能多地预加载
        preloader.load(); // 开始加载
        audioPreloaders.set(item.file, preloader);
        item.preloaded = true;
    }
}

function displayPlaylist() {
    playlistDisplay.innerHTML = '';
    if (schedule.length === 0) {
        playlistDisplay.innerHTML = 'No valid data in CSV to display playlist.';
        return;
    }

    schedule.forEach((item, index) => {
        const div = document.createElement('div');
        div.classList.add('playlist-item');
        div.dataset.index = index;
        // 显示时长为 'Loading...' 直到获取到实际时长
        div.textContent = `${formatDateTime(item.time)}: ${item.file} (Duration: ${item.duration ? formatTime(item.duration) : 'Loading...'})`;
        playlistDisplay.appendChild(div);

        // 点击播放列表项，跳到并播放该曲目
        div.addEventListener('click', async () => {
            if (item.url) {
                // 如果时长未知，先加载元数据
                if (item.status !== 'metadata_loaded') {
                    currentInfoDisplay.innerHTML = `Loading metadata for ${item.file}...`;
                    await loadAudioMetadata(item);
                    // 更新播放列表中的时长显示
                    div.textContent = `${formatDateTime(item.time)}: ${item.file} (Duration: ${item.duration ? formatTime(item.duration) : 'N/A'})`;
                }
                currentPlayIndex = index;
                audioPlayer.src = item.url;
                audioPlayer.currentTime = 0; // 从头开始播放
                audioPlayer.play();
                highlightPlaylistItem(currentPlayIndex);
                currentInfoDisplay.innerHTML = `Manually playing: ${item.file}`;
                // 重置预加载标记，以便从新位置开始正确预加载
                nextTrackPreloadTriggered = false;
            } else {
                alert(`Audio URL for "${item.file}" not available.`);
            }
        });
    });
}

// 核心同步逻辑
async function synchronizePlayback() {
    if (!radioStartTime || schedule.length === 0) {
        currentInfoDisplay.innerHTML = 'Radio schedule not ready for synchronization.';
        return;
    }

    const now = new Date();
    const elapsedSecondsSinceRadioStart = (now.getTime() - radioStartTime.getTime()) / 1000;

    let foundIndex = -1;
    let seekTimeInCurrentTrack = 0;

    for (let i = 0; i < schedule.length; i++) {
        const item = schedule[i];

        // 如果时长未知，尝试加载元数据并等待，以便进行准确计算
        if (item.status !== 'metadata_loaded' && item.status !== 'error') {
            currentInfoDisplay.innerHTML = `Determining duration for ${item.file}...`;
            await loadAudioMetadata(item);
            // 更新播放列表中的时长显示
            const playlistItemDiv = document.querySelector(`.playlist-item[data-index="${i}"]`);
            if (playlistItemDiv) {
                 playlistItemDiv.textContent = `${formatDateTime(item.time)}: ${item.file} (Duration: ${item.duration ? formatTime(item.duration) : 'N/A'})`;
            }
        }

        if (item.duration === 0) { // 如果时长仍然未知或为0，跳过此项
            console.warn(`Skipping ${item.file} due to unknown or zero duration.`);
            continue;
        }

        const itemStartTimeRelative = (item.time.getTime() - radioStartTime.getTime()) / 1000;

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
        });
        highlightPlaylistItem(currentPlayIndex);
        currentInfoDisplay.innerHTML = `Synchronized to: ${currentItem.file} at ${formatTime(seekTimeInCurrentTrack)}`;
        nextTrackPreloadTriggered = false; // 重置预加载标记
    } else {
        // 如果当前时间不在任何预定播放时段内，从第一个有效曲目开始播放
        currentInfoDisplay.innerHTML = 'Not currently within any scheduled broadcast slot. Starting from beginning.';
        currentPlayIndex = 0; 
        while (currentPlayIndex < schedule.length && schedule[currentPlayIndex].status === 'error') {
             currentPlayIndex++; // 跳过无法播放的曲目
        }
        if (currentPlayIndex < schedule.length && schedule[currentPlayIndex].url) {
            const firstPlayableItem = schedule[currentPlayIndex];
            // 确保第一个可播放曲目的元数据已加载
            if (firstPlayableItem.status !== 'metadata_loaded') {
                await loadAudioMetadata(firstPlayableItem);
                const playlistItemDiv = document.querySelector(`.playlist-item[data-index="${currentPlayIndex}"]`);
                if (playlistItemDiv) {
                    playlistItemDiv.textContent = `${formatDateTime(firstPlayableItem.time)}: ${firstPlayableItem.file} (Duration: ${firstPlayableItem.duration ? formatTime(firstPlayableItem.duration) : 'N/A'})`;
                }
            }

            audioPlayer.src = firstPlayableItem.url;
            audioPlayer.currentTime = 0;
            audioPlayer.play().catch(error => {
                console.error("Autoplay failed:", error);
                currentInfoDisplay.innerHTML = `Autoplay blocked. Click play. Starting: ${firstPlayableItem.file}`;
            });
            highlightPlaylistItem(currentPlayIndex);
            nextTrackPreloadTriggered = false; // 重置预加载标记
        } else {
             currentInfoDisplay.innerHTML = 'No schedule or audio files to play.';
        }
    }
}


async function playNextAudio() {
    currentPlayIndex++;
    if (currentPlayIndex < schedule.length) {
        const nextItem = schedule[currentPlayIndex];
        // 确保下一首的元数据已加载
        if (nextItem.status !== 'metadata_loaded' && nextItem.status !== 'error') {
            currentInfoDisplay.innerHTML = `Loading metadata for next track: ${nextItem.file}...`;
            await loadAudioMetadata(nextItem);
            // 更新播放列表中的时长显示
            const playlistItemDiv = document.querySelector(`.playlist-item[data-index="${currentPlayIndex}"]`);
            if (playlistItemDiv) {
                 playlistItemDiv.textContent = `${formatDateTime(nextItem.time)}: ${nextItem.file} (Duration: ${nextItem.duration ? formatTime(nextItem.duration) : 'N/A'})`;
            }
        }
        
        if (nextItem.url && nextItem.status !== 'error') {
            audioPlayer.src = nextItem.url;
            audioPlayer.load(); // 预加载下一首音频的数据
            audioPlayer.play().catch(error => {
                 console.warn("Autoplay of next track failed:", error);
                 currentInfoDisplay.innerHTML = `Autoplay blocked for ${nextItem.file}. Click play.`;
            });
            highlightPlaylistItem(currentPlayIndex);
            updateCurrentInfo();
            nextTrackPreloadTriggered = false; // 重置预加载标记
        } else {
            console.error(`Next audio file URL missing or error status for index ${currentPlayIndex}: ${nextItem.file}`);
            currentInfoDisplay.innerHTML = `Error: Cannot play next file (${nextItem.file}). URL missing or error. Trying next...`;
            // 跳过此文件，尝试播放再下一首
            playNextAudio();
        }
    } else {
        currentInfoDisplay.innerHTML = 'Radio broadcast finished.';
        currentPlayIndex = -1; // Reset
        highlightPlaylistItem(-1); // De-highlight all
    }
}

// 检查是否需要预加载下一首音频
function checkPreloadNextAudio() {
    // 确保有音频正在播放且有下一首
    if (audioPlayer.paused || audioPlayer.ended || currentPlayIndex === -1 || !schedule[currentPlayIndex] || currentPlayIndex >= schedule.length - 1) {
        return;
    }

    const currentItem = schedule[currentPlayIndex];
    const nextItem = schedule[currentPlayIndex + 1];

    if (!currentItem || !nextItem || nextTrackPreloadTriggered) {
        return;
    }
    
    // 如果当前曲目的时长未知，或者正在加载，则无法计算剩余时间，暂时不预加载
    if (currentItem.status !== 'metadata_loaded' || currentItem.duration === 0) {
        return;
    }

    const timeLeftInCurrentTrack = currentItem.duration - audioPlayer.currentTime;

    // 如果当前曲目剩余时间小于预加载阈值，并且下一首曲目尚未被预加载
    if (timeLeftInCurrentTrack <= PRELOAD_THRESHOLD_SECONDS && !nextItem.preloaded) {
        console.log(`Time left in current track (${formatTime(timeLeftInCurrentTrack)}) is less than ${PRELOAD_THRESHOLD_SECONDS}s. Preloading next track: ${nextItem.file}`);
        preloadAudioData(nextItem); // 触发预加载下一首音频的数据
        nextTrackPreloadTriggered = true; // 标记已触发，避免重复预加载
    }
}


function updateCurrentInfo() {
    if (currentPlayIndex !== -1 && schedule[currentPlayIndex]) {
        const currentItem = schedule[currentPlayIndex];
        const currentTime = audioPlayer.currentTime;
        const duration = audioPlayer.duration; // 这里的 duration 应该是实际加载的音频时长
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
    const currentFile = schedule[currentPlayIndex]?.file || 'N/A';
    currentInfoDisplay.innerHTML = `Audio playback error! (${errorMsg}). Check console for details. File: ${currentFile}`;
    
    // 如果是网络或源文件不支持的错误，尝试播放下一首
    if (e.target.error.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED || e.target.error.code === MediaError.MEDIA_ERR_NETWORK) {
         console.warn(`Attempting to play next audio due to error with ${currentFile}.`);
         // 标记当前出错的曲目为 error 状态，避免再次尝试
         if (schedule[currentPlayIndex]) {
             schedule[currentPlayIndex].status = 'error';
         }
         playNextAudio();
    }
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
