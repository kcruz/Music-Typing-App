const textDisplay = document.getElementById('textDisplay');
const clearBtn = document.getElementById('clearBtn');
const muteBtn = document.getElementById('muteBtn');
const scaleSelect = document.getElementById('scaleSelect');
const playBtn = document.getElementById('playBtn');
const downloadBtn = document.getElementById('downloadBtn');
const volumeSlider = document.getElementById('volumeSlider');
const calmerSlider = document.getElementById('calmerSlider');
const hiddenInput = document.getElementById('hiddenInput');
const paper = document.querySelector('.paper');
const playbackBall = document.getElementById('playbackBall');

let isMuted = false;
let volumeLevel = 0.7;
let calmerLevel = 0;
let audioContext;
let currentScale = 'meditation';
let masterGainNode;
let compressorNode;
let lowPassFilterNode;
let typedText = '';
const INPUT_SENTINEL = '\u200B';

// Calmer: 0% = 10kHz (full clarity), 100% = 1.2kHz (warm, soft)
function calmerToFreq(calmer01) {
    const minFreq = 1200;
    const maxFreq = 10000;
    return minFreq + (1 - calmer01) * (maxFreq - minFreq);
}

function getAudioContextClass() {
    return window.AudioContext || window.webkitAudioContext;
}

function playUnlockPulse() {
    const source = audioContext.createBufferSource();
    source.buffer = audioContext.createBuffer(1, 1, audioContext.sampleRate);
    source.connect(audioContext.destination);
    source.start(0);
}

function createAudioGraph(AudioContextClass) {
    audioContext = new AudioContextClass();

    compressorNode = audioContext.createDynamicsCompressor();
    compressorNode.threshold.value = -24;
    compressorNode.knee.value = 30;
    compressorNode.ratio.value = 6;
    compressorNode.attack.value = 0.003;
    compressorNode.release.value = 0.15;

    lowPassFilterNode = audioContext.createBiquadFilter();
    lowPassFilterNode.type = 'lowpass';
    lowPassFilterNode.frequency.value = calmerToFreq(calmerLevel);
    lowPassFilterNode.Q.value = 0.7;

    masterGainNode = audioContext.createGain();
    masterGainNode.gain.value = volumeLevel;

    compressorNode.connect(lowPassFilterNode);
    lowPassFilterNode.connect(masterGainNode);
    masterGainNode.connect(audioContext.destination);
}

// Initialize audio context — fully synchronous so it never breaks the
// user-gesture chain that iOS Safari requires for audio playback.
function initAudio() {
    const AudioContextClass = getAudioContextClass();
    if (!AudioContextClass) return false;

    if (!audioContext) {
        createAudioGraph(AudioContextClass);
        // Play silent buffer immediately during the gesture to unlock iOS audio
        playUnlockPulse();
    }

    // resume() returns a promise but we fire-and-forget to stay synchronous
    if (audioContext.state === 'suspended' && audioContext.resume) {
        audioContext.resume();
    }

    return true;
}

function isAudioReady() {
    return audioContext && audioContext.state === 'running';
}

// Unlock audio on the earliest possible user gesture. Pointer events cover
// touch, pen, and mouse; the extra touchstart listener helps older iOS Safari.
['pointerdown', 'touchstart', 'keydown'].forEach(evt => {
    document.addEventListener(evt, initAudio, { once: true, passive: true });
});

function getMasterInput() {
    return compressorNode || audioContext.destination;
}

// Musical scales (MIDI note numbers)
const scales = {
    meditation: [60, 64, 67, 71, 72, 76, 79, 83, 84], // C major 7 – peaceful, calming
    pentatonic: [60, 62, 64, 67, 69, 72, 74, 76, 79, 81, 84], // C Pentatonic
    major: [60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79, 81, 83, 84], // C Major
    minor: [60, 62, 63, 65, 67, 68, 70, 72, 74, 75, 77, 79, 80, 82, 84], // C Minor
    chromatic: [60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76], // Chromatic
    blues: [60, 63, 65, 66, 67, 70, 72, 75, 77, 78, 79, 82, 84] // C Blues
};

const colors = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8',
    '#F7DC6F', '#BB8FCE', '#85C1E2', '#F8B195', '#C06C84'
];

function midiToFrequency(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
}

// Playback: same envelope as live typing
const NOTE_INTERVAL = 0.35;
const LETTER_DURATION = 3.02;
const LETTER_SUSTAIN = 0.22;
const SPACE_DURATION = 1.8;
const SPACE_GAIN = 0.18;
const fallbackToneUrls = new Map();

function writePcmWav(samples, sampleRate) {
    const bytesPerSample = 2;
    const dataSize = samples.length * bytesPerSample;
    const arrayBuffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(arrayBuffer);
    const writeStr = (offset, str) => {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerSample, true);
    view.setUint16(32, bytesPerSample, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (const sample of samples) {
        const clamped = Math.max(-1, Math.min(1, sample));
        const value = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
        view.setInt16(offset, value, true);
        offset += 2;
    }

    return new Blob([arrayBuffer], { type: 'audio/wav' });
}

function getFallbackToneUrl(midiNote, duration, gainLevel) {
    const key = `${midiNote}:${duration}:${gainLevel}`;
    if (fallbackToneUrls.has(key)) return fallbackToneUrls.get(key);

    const frequency = midiToFrequency(midiNote);
    const sampleRate = 22050;
    const sampleCount = Math.max(1, Math.ceil(duration * sampleRate));
    const samples = new Float32Array(sampleCount);
    const attackSamples = Math.max(1, Math.floor(0.02 * sampleRate));
    const releaseSamples = Math.max(1, Math.floor(Math.min(0.6, duration * 0.4) * sampleRate));

    for (let i = 0; i < sampleCount; i++) {
        const attack = Math.min(1, i / attackSamples);
        const releaseStart = sampleCount - releaseSamples;
        const release = i > releaseStart ? Math.max(0, (sampleCount - i) / releaseSamples) : 1;
        const envelope = Math.min(attack, release);
        samples[i] = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * gainLevel * envelope;
    }

    const url = URL.createObjectURL(writePcmWav(samples, sampleRate));
    fallbackToneUrls.set(key, url);
    return url;
}

function playFallbackTone(midiNote, duration, gainLevel) {
    if (isMuted) return;

    const audio = new Audio(getFallbackToneUrl(midiNote, duration, gainLevel));
    audio.volume = volumeLevel;
    audio.play().catch(err => console.error('Fallback audio playback failed:', err));
}

function playFallbackScore(score) {
    score.forEach((note, i) => {
        setTimeout(() => {
            const duration = note.isSpace ? SPACE_DURATION : LETTER_DURATION;
            const gainLevel = note.isSpace ? SPACE_GAIN : LETTER_SUSTAIN;
            playFallbackTone(note.midiNote, duration, gainLevel);
        }, i * NOTE_INTERVAL * 1000);
    });
    runPlaybackBall(getLetterPositions());
}

function getScoreFromDisplay() {
    const scale = scales[currentScale];
    return Array.from(typedText, char => {
        if (char === ' ') {
            return { midiNote: scale[0], isSpace: true };
        }

        const noteIndex = char.charCodeAt(0) % scale.length;
        return { midiNote: scale[noteIndex], isSpace: false };
    });
}

function scheduleNoteAt(ctx, destination, startTime, midiNote, isSpace) {
    const frequency = midiToFrequency(midiNote);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(destination);
    osc.frequency.value = frequency;
    osc.type = 'sine';

    const attack = 0.02;
    if (isSpace) {
        const releaseTime = 1;
        const sustainTime = Math.max(0, SPACE_DURATION - attack - releaseTime);
        gain.gain.setValueAtTime(0, startTime);
        gain.gain.linearRampToValueAtTime(SPACE_GAIN, startTime + attack);
        gain.gain.setValueAtTime(SPACE_GAIN, startTime + attack + sustainTime);
        gain.gain.exponentialRampToValueAtTime(0.001, startTime + SPACE_DURATION);
        osc.start(startTime);
        osc.stop(startTime + SPACE_DURATION);
    } else {
        const sustainLevel = LETTER_SUSTAIN;
        const sustainTime = 2;
        const releaseTime = 1;
        const total = attack + sustainTime + releaseTime;
        gain.gain.setValueAtTime(0, startTime);
        gain.gain.linearRampToValueAtTime(sustainLevel, startTime + attack);
        gain.gain.setValueAtTime(sustainLevel, startTime + attack + sustainTime);
        gain.gain.exponentialRampToValueAtTime(0.001, startTime + total);
        osc.start(startTime);
        osc.stop(startTime + total);
    }
}

function getLetterPositions() {
    const containerRect = textDisplay.getBoundingClientRect();
    const positions = [];
    textDisplay.querySelectorAll('.letter').forEach(span => {
        const r = span.getBoundingClientRect();
        positions.push({
            left: r.left - containerRect.left + r.width / 2,
            top: r.top - containerRect.top - 8
        });
    });
    return positions;
}

let playbackBallTimeoutIds = [];

function runPlaybackBall(letterPositions) {
    const ball = playbackBall;
    if (!ball || letterPositions.length === 0) return;

    playbackBallTimeoutIds.forEach(id => clearTimeout(id));
    playbackBallTimeoutIds = [];

    ball.style.left = letterPositions[0].left + 'px';
    ball.style.top = letterPositions[0].top + 'px';
    ball.style.transform = 'translate(-50%, -100%)';
    ball.classList.add('playing');

    const intervalMs = NOTE_INTERVAL * 1000;
    for (let i = 1; i < letterPositions.length; i++) {
        const id = setTimeout(() => {
            const pos = letterPositions[i];
            ball.style.left = pos.left + 'px';
            ball.style.top = pos.top + 'px';
            ball.classList.remove('bounce');
            ball.offsetHeight;
            ball.classList.add('bounce');
        }, i * intervalMs);
        playbackBallTimeoutIds.push(id);
    }

    const hideId = setTimeout(() => {
        ball.classList.remove('playing', 'bounce');
        playbackBallTimeoutIds = playbackBallTimeoutIds.filter(id => id !== hideId);
    }, letterPositions.length * intervalMs + 400);
    playbackBallTimeoutIds.push(hideId);
}

function playScore() {
    const score = getScoreFromDisplay();
    if (score.length === 0) return;
    initAudio();
    if (!audioContext || isMuted) return;

    const now = audioContext.currentTime;
    score.forEach((note, i) => {
        scheduleNoteAt(audioContext, getMasterInput(), now + i * NOTE_INTERVAL, note.midiNote, note.isSpace);
    });
    runPlaybackBall(getLetterPositions());
}

function renderScoreToWav(score) {
    if (score.length === 0) return null;
    const OfflineContextClass = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OfflineContextClass) return Promise.reject(new Error('Offline audio rendering is not supported in this browser.'));

    const totalDuration = score.length * NOTE_INTERVAL + 4;
    const sampleRate = 44100;
    const numChannels = 1;
    const numSamples = Math.ceil(totalDuration * sampleRate);
    const ctx = new OfflineContextClass(numChannels, numSamples, sampleRate);
    const masterGain = ctx.createGain();
    masterGain.gain.value = 0.45;
    masterGain.connect(ctx.destination);

    score.forEach((note, i) => {
        scheduleNoteAt(ctx, masterGain, i * NOTE_INTERVAL, note.midiNote, note.isSpace);
    });

    return ctx.startRendering().then(buffer => bufferToWav(buffer));
}

function bufferToWav(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const channel = buffer.getChannelData(0);
    const length = channel.length;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const dataSize = length * blockAlign;
    const bufferLength = 44 + dataSize;
    const arrayBuffer = new ArrayBuffer(bufferLength);
    const view = new DataView(arrayBuffer);
    const writeStr = (offset, str) => {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, bufferLength - 8, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);  // fmt chunk size
    view.setUint16(20, 1, true);   // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);  // bits per sample
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);
    let offset = 44;
    for (let i = 0; i < length; i++) {
        const s = Math.max(-1, Math.min(1, channel[i]));
        const v = s < 0 ? s * 0x8000 : s * 0x7FFF;
        view.setInt16(offset, v, true);
        offset += 2;
    }
    return new Blob([arrayBuffer], { type: 'audio/wav' });
}

function playNote(charCode, x, y) {
    if (isMuted || !audioContext) return;
    initAudio();

    const scale = scales[currentScale];
    const noteIndex = charCode % scale.length;
    const midiNote = scale[noteIndex];
    const frequency = midiToFrequency(midiNote);

    // Create oscillator
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(getMasterInput());

    oscillator.frequency.value = frequency;
    oscillator.type = 'sine';

    // Envelope: short attack, 2s sustain, 1s fade to silence
    const now = audioContext.currentTime;
    const attack = 0.02;
    const sustainLevel = 0.22;
    const sustainTime = 2;
    const releaseTime = 1;
    const totalDuration = attack + sustainTime + releaseTime;

    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(sustainLevel, now + attack);
    gainNode.gain.setValueAtTime(sustainLevel, now + attack + sustainTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, now + totalDuration);

    oscillator.start(now);
    oscillator.stop(now + totalDuration);

    // Visual feedback
    createNoteParticle(x, y, charCode);
}

// Play a fixed note (for spacebar & backspace) with optional duration
function playFixedNote(midiNote, x, y, duration = 2, gainLevel = 0.2) {
    if (isMuted || !audioContext) return;
    initAudio();

    const frequency = midiToFrequency(midiNote);
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(getMasterInput());

    oscillator.frequency.value = frequency;
    oscillator.type = 'sine';

    const now = audioContext.currentTime;
    const attack = 0.02;
    const releaseTime = 1;
    const sustainTime = Math.max(0, duration - attack - releaseTime);

    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(gainLevel, now + attack);
    gainNode.gain.setValueAtTime(gainLevel, now + attack + sustainTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, now + duration);

    oscillator.start(now);
    oscillator.stop(now + duration);

    createNoteParticle(x, y, midiNote);
}

function createNoteParticle(x, y, charCode) {
    const particle = document.createElement('div');
    particle.className = 'note-particle';
    particle.textContent = '♪';
    particle.style.left = x + 'px';
    particle.style.top = y + 'px';
    particle.style.color = colors[charCode % colors.length];
    
    document.body.appendChild(particle);
    
    setTimeout(() => {
        particle.remove();
    }, 2000);
}

function createLetter(char) {
    const span = document.createElement('span');
    span.className = char === ' ' ? 'letter space' : 'letter';
    span.textContent = char;
    return span;
}

function renderText() {
    textDisplay.querySelectorAll('.word, .letter.space').forEach(node => node.remove());
    Array.from(textDisplay.childNodes).forEach(node => {
        if (node.nodeType === Node.TEXT_NODE) {
            node.remove();
        }
    });
    textDisplay.classList.toggle('has-text', typedText.length > 0);

    let currentWord = null;
    for (const char of typedText) {
        if (char === ' ') {
            currentWord = null;
            textDisplay.appendChild(createLetter(char));
            continue;
        }

        if (!currentWord) {
            currentWord = document.createElement('span');
            currentWord.className = 'word';
            textDisplay.appendChild(currentWord);
        }
        currentWord.appendChild(createLetter(char));
    }

    if (playbackBall && playbackBall.parentElement !== textDisplay) {
        textDisplay.appendChild(playbackBall);
    }
}

function focusInput() {
    hiddenInput.focus();
}

function activatePaper() {
    initAudio();
    focusInput();
}

paper.addEventListener('pointerdown', activatePaper);
paper.addEventListener('click', activatePaper);

function handleBackspace() {
    initAudio();
    const x = window.innerWidth / 2 + (Math.random() - 0.5) * 200;
    const y = window.innerHeight / 2 + (Math.random() - 0.5) * 100;
    const scale = scales[currentScale];
    if (typedText.length > 0) {
        typedText = typedText.slice(0, -1);
        renderText();
    }
    playFixedNote(scale[scale.length - 1], x, y, 1.2, 0.2);
}

hiddenInput.addEventListener('beforeinput', (e) => {
    if (e.inputType === 'deleteContentBackward' || e.inputType === 'deleteContentForward') {
        e.preventDefault();
        handleBackspace();
        hiddenInput.value = INPUT_SENTINEL;
        hiddenInput.setSelectionRange(1, 1);
    }
});

hiddenInput.addEventListener('input', (e) => {
    initAudio();
    const data = e.data || hiddenInput.value.split(INPUT_SENTINEL).join('');
    if (!data) return;

    const x = window.innerWidth / 2 + (Math.random() - 0.5) * 200;
    const y = window.innerHeight / 2 + (Math.random() - 0.5) * 100;
    const scale = scales[currentScale];

    for (const char of data) {
        if (char === ' ') {
            typedText += ' ';
            playFixedNote(scale[0], x, y, 1.8, 0.18);
        } else {
            const charCode = char.charCodeAt(0);
            typedText += char;
            playNote(charCode, x, y);
        }
    }
    renderText();
    hiddenInput.value = INPUT_SENTINEL;
    hiddenInput.setSelectionRange(1, 1);
});

hiddenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace') {
        e.preventDefault();
        handleBackspace();
    }
});

hiddenInput.value = INPUT_SENTINEL;
focusInput();

clearBtn.addEventListener('click', () => {
    typedText = '';
    renderText();
});

muteBtn.addEventListener('click', () => {
    isMuted = !isMuted;
    muteBtn.textContent = isMuted ? 'Unmute 🔇' : 'Mute 🔊';
});

scaleSelect.addEventListener('change', (e) => {
    currentScale = e.target.value;
});

volumeSlider.addEventListener('input', (e) => {
    volumeLevel = e.target.value / 100;
    if (masterGainNode) {
        masterGainNode.gain.value = volumeLevel;
    }
});

calmerSlider.addEventListener('input', (e) => {
    calmerLevel = e.target.value / 100;
    if (lowPassFilterNode) {
        lowPassFilterNode.frequency.setTargetAtTime(calmerToFreq(calmerLevel), audioContext.currentTime, 0.05);
    }
});

playBtn.addEventListener('click', () => {
    playScore();
});

downloadBtn.addEventListener('click', () => {
    const score = getScoreFromDisplay();
    if (score.length === 0) {
        return;
    }
    initAudio();
    playBtn.disabled = true;
    downloadBtn.disabled = true;
    downloadBtn.textContent = 'Rendering…';
    renderScoreToWav(score).then(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `musical-typing-${Date.now()}.wav`;
        a.click();
        URL.revokeObjectURL(url);
    }).catch(err => console.error(err)).finally(() => {
        playBtn.disabled = false;
        downloadBtn.disabled = false;
        downloadBtn.textContent = '⬇ Download';
    });
});

renderText();
