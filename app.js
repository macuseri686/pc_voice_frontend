(function() {
  const originalLog = console.log.bind(console);
  console.log = (...args) => {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const ms = String(now.getMilliseconds()).padStart(3, '0');
    originalLog(
      `[${hh}:${mm}:${ss}.${ms}]`,
      ...args
    );
  };
})();

const statusDiv = document.getElementById("status");
const messagesDiv = document.getElementById("messages");
const speedSlider = document.getElementById("speedSlider");
const userID = 1234;
speedSlider.disabled = true;  // start disabled

let socket = null;
let mediaStream = null;
let audioContext = null;
let audioQueue = [];
let isPlaying = false;
let audioProcessor = null;
let currentAudioSource = null;  // Add reference to current audio source
let userAnalyser;
let assistantAnalyser;
let userVisualization = null;
let assistantVisualization = null;
let animationFrameId = null;
let isAISpeaking = false;
let lastUserSpeechTime = 0;
const INTERRUPTION_THRESHOLD = 0.5;
let isInterrupted = false;  // New flag to track interruption state
let userSpeakingBubble = null;
let assistantSpeakingBubble = null;

let chatHistory = [];

// Initialize audio context
function initAudioContext() {
  if (!audioContext) {
    // Create AudioContext with system default sample rate
    audioContext = new AudioContext();
  }
  isInterrupted = true;  // Set interrupted flag
}

function stopCurrentAudio() {
  if (currentAudioSource) {
    try {
      currentAudioSource.stop();
    } catch (e) {
      // Ignore errors from already stopped sources
    }
    currentAudioSource = null;
  }
  isPlaying = false;
  isAISpeaking = false;
  isInterrupted = true;  // Set interrupted flag

  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }

  if (assistantVisualization) {
    assistantVisualization.cancel();
    assistantVisualization = null;
  }

  if (assistantSpeakingBubble) {
    if (assistantSpeakingBubble.content?.trim()) {
      assistantSpeakingBubble.state = 'complete';
    } else {
      // If no content, remove the speaking bubble from history.
      const index = chatHistory.indexOf(assistantSpeakingBubble);
      if (index > -1) {
        chatHistory.splice(index, 1);
      }
    }
    renderMessages();
    assistantSpeakingBubble = null;
  }
}

// Handle audio playback
function playAudioChunk(base64Audio, bubbleElement) {
  console.log("playAudioChunk called for bubble:", bubbleElement);
  if (!audioContext) {
    initAudioContext();
  }

  try {
    // Convert base64 to Int16Array
    const binaryString = atob(base64Audio);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    // Create audio buffer at 16000 Hz for playback
    const audioBuffer = audioContext.createBuffer(1, bytes.length / 2, 16000);
    const channelData = audioBuffer.getChannelData(0);
    
    // Convert Int16 to Float32
    const int16Array = new Int16Array(bytes.buffer);
    for (let i = 0; i < int16Array.length; i++) {
      channelData[i] = int16Array[i] / 32768.0;
    }

    // Only stop current audio if we're starting a new response
    if (audioQueue.length === 0) {
      stopCurrentAudio();
    }

    // Play the audio
    const source = audioContext.createBufferSource();
    currentAudioSource = source;
    source.buffer = audioBuffer;

    source.connect(assistantAnalyser);
    
    source.onended = () => {
      if (currentAudioSource === source) {
        currentAudioSource = null;
        isPlaying = false;
        if (!isInterrupted) {
          playNextInQueue();
        }
      }
    };

    isPlaying = true;
    isAISpeaking = true;
    source.start(0);
  } catch (error) {
    console.error('Error playing audio:', error);
    stopCurrentAudio();
    if (!isInterrupted) {
      playNextInQueue();
    }
  }
}

function playNextInQueue() {
  console.log("playNextInQueue called. isPlaying:", isPlaying, "isInterrupted:", isInterrupted, "Queue length:", audioQueue.length);
  if (audioQueue.length > 0 && !isPlaying && !isInterrupted) {
    const { audio, bubble } = audioQueue.shift();
    console.log("Dequeuing chunk to play. Bubble element:", bubble);

    if (bubble && !assistantVisualization) {
      console.log("Attempting to start visualization.");
      const waveformBars = bubble.querySelectorAll('.waveform-bar');
      if (waveformBars.length > 0) {
        console.log("Found", waveformBars.length, "waveform bars. Starting visualization.");
        assistantVisualization = visualize(assistantAnalyser, waveformBars);
      } else {
        console.error("Could not find waveform bars in bubble element.");
      }
    } else if (!bubble) {
        console.error("Cannot start visualization: bubble is null.");
    } else if (assistantVisualization) {
        console.log("Visualization already active.");
    }
    
    playAudioChunk(audio, bubble);
  } else if (!isPlaying && audioQueue.length === 0) {
    if (assistantVisualization) {
      assistantVisualization.cancel();
      assistantVisualization = null;
    }
    if (assistantSpeakingBubble) {
      assistantSpeakingBubble.state = 'complete';
      renderMessages();
      assistantSpeakingBubble = null;
    }
  }
}

function queueAudioChunk(base64Audio, bubbleElement) {
  console.log("Queueing audio chunk. New queue length:", audioQueue.length + 1);
  if (isInterrupted) {
    // If we're interrupted, clear the queue and start fresh
    audioQueue = [{ audio: base64Audio, bubble: bubbleElement }];
    isInterrupted = false;
  } else {
    audioQueue.push({ audio: base64Audio, bubble: bubbleElement });
  }
  
  if (!isPlaying) {
    playNextInQueue();
  }
}

function cleanupAudio() {
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  if (mediaStream) {
    mediaStream.getAudioTracks().forEach(track => track.stop());
    mediaStream = null;
  }
  audioQueue = [];
  isPlaying = false;
}

function renderMessages() {
  messagesDiv.innerHTML = "";
  chatHistory.forEach(msg => {
    const bubble = document.createElement("div");
    bubble.className = `bubble ${msg.role}`;
    if (msg.state === 'speaking') {
      bubble.classList.add('speaking-bubble');
      let barsHtml = '';
      for (let i = 0; i < 20; i++) {
        barsHtml += '<div class="waveform-bar"></div>';
      }
      bubble.innerHTML = `
        <div class="waveform">
          ${barsHtml}
        </div>
      `;
    } else {
      bubble.textContent = msg.content;
    }
    messagesDiv.appendChild(bubble);
  });
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function handleJSONMessage(data) {
  if (data.type === "user_transcript") {
    const transcript = data.user_transcription_event.user_transcript;
    if (transcript?.trim()) {
      if (userVisualization) {
        userVisualization.cancel();
        userVisualization = null;
      }
      if (userSpeakingBubble) {
        userSpeakingBubble.content = transcript;
        userSpeakingBubble.state = 'complete';
        userSpeakingBubble = null;
      } else {
        chatHistory.push({ role: "user", content: transcript });
      }
      renderMessages();
    }
  } else if (data.type === "agent_response") {
    const response = data.agent_response_event.agent_response;
    if (response?.trim()) {
      if (assistantSpeakingBubble) {
        assistantSpeakingBubble.content = response;
      } else {
        // Fallback in case response comes before any audio
        assistantSpeakingBubble = { role: "assistant", state: "speaking", content: response };
        chatHistory.push(assistantSpeakingBubble);
        renderMessages();
      }
      // Reset interruption state for new response
      isInterrupted = false;
    }
  } else if (data.type === "audio") {
    const audioData = data.audio_event.audio_base_64;
    if (audioData) {
      if (!assistantSpeakingBubble) {
        console.log("First audio chunk received. Creating assistant bubble and analyser.");
        assistantSpeakingBubble = { role: 'assistant', state: 'speaking', content: '' };
        chatHistory.push(assistantSpeakingBubble);
        renderMessages();
        assistantSpeakingBubble.element = messagesDiv.lastChild;

        assistantAnalyser = audioContext.createAnalyser();
        assistantAnalyser.fftSize = 64;
        assistantAnalyser.connect(audioContext.destination);
      }
      queueAudioChunk(audioData, assistantSpeakingBubble.element);
    }
  } else if (data.type === "interruption") {
    console.log('Interruption received:', data.interruption_event);
    stopCurrentAudio();
  } else if (data.type === "ping") {
    // Send pong response
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: "pong",
        event_id: data.ping_event.event_id
      }));
    }
  }
}

// UI Controls
document.getElementById("clearBtn").onclick = () => {
  chatHistory = [];
  userSpeakingBubble = null;
  assistantSpeakingBubble = null;
  renderMessages();
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'clear_history' }));
  }
};

document.getElementById("startBtn").onclick = async () => {
  if (socket && socket.readyState === WebSocket.OPEN) {
    statusDiv.textContent = "Already connected.";
    return;
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    statusDiv.textContent = "Initializing connection...";
    
    // Connect to ElevenLabs WebSocket
    socket = new WebSocket(`wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_01jxdezqqfeb0avrq5mc9eb18w`);

    socket.onopen = () => {
      statusDiv.textContent = "Connected. Ready to chat!";
      speedSlider.disabled = false;
      
      // Initialize audio processing
      initAudioContext();
      const source = audioContext.createMediaStreamSource(mediaStream);
      
      userAnalyser = audioContext.createAnalyser();
      userAnalyser.fftSize = 64;
      source.connect(userAnalyser);

      audioProcessor = audioContext.createScriptProcessor(1024, 1, 1);
      
      audioProcessor.onaudioprocess = (e) => {
        if (socket.readyState === WebSocket.OPEN) {
          const inputData = e.inputBuffer.getChannelData(0);
          
          // Detect if user is speaking by checking audio levels
          const audioLevel = Math.max(...inputData.map(Math.abs));
          const now = Date.now();
          
          // If user starts speaking while AI is talking, send interruption
          if (audioLevel > INTERRUPTION_THRESHOLD && isAISpeaking && now - lastUserSpeechTime > 500) {
            console.log('User interruption detected');
            stopCurrentAudio();  // Stop audio immediately on interruption
            socket.send(JSON.stringify({
              type: "user_message",
              text: "interrupt"
            }));
            lastUserSpeechTime = now;
          }
          
          // Update last speech time if user is speaking
          if (audioLevel > INTERRUPTION_THRESHOLD) {
            if (!userSpeakingBubble) {
              userSpeakingBubble = { role: 'user', state: 'speaking', content: '' };
              chatHistory.push(userSpeakingBubble);
              renderMessages();
              userSpeakingBubble.element = messagesDiv.lastChild;
              if (userSpeakingBubble.element && !userVisualization) {
                  const waveformBars = userSpeakingBubble.element.querySelectorAll('.waveform-bar');
                  userVisualization = visualize(userAnalyser, waveformBars);
              }
            }
            lastUserSpeechTime = now;
          }
          
          // Resample to 16000 Hz
          const resampledData = resampleAudio(inputData, audioContext.sampleRate, 16000);
          const pcmData = new Int16Array(resampledData.length);
          
          // Convert Float32 to Int16
          for (let i = 0; i < resampledData.length; i++) {
            const s = Math.max(-1, Math.min(1, resampledData[i]));
            pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          }
          
          // Convert to base64
          const base64Audio = btoa(String.fromCharCode.apply(null, new Uint8Array(pcmData.buffer)));
          
          // Send as JSON message
          const message = {
            type: "user_audio_chunk",
            user_audio_chunk: base64Audio
          };
          
          socket.send(JSON.stringify(message));
        }
      };
      
      source.connect(audioProcessor);
      audioProcessor.connect(audioContext.destination);
    };

    socket.onmessage = (event) => {
      try {
        if (event.data instanceof Blob) {
          // Handle binary audio data
          const reader = new FileReader();
          reader.onload = () => {
            const arrayBuffer = reader.result;
            const audioData = btoa(String.fromCharCode.apply(null, new Uint8Array(arrayBuffer)));
            queueAudioChunk(audioData, messagesDiv.lastChild);
          };
          reader.readAsArrayBuffer(event.data);
        } else {
          // Handle JSON messages
          const data = JSON.parse(event.data);
          console.log('Received message:', data); // Debug log
          
          if (data.type === "conversation_initiation_metadata") {
            console.log('Conversation initialized:', data.conversation_initiation_metadata_event);
            return;
          }
          
          handleJSONMessage(data);
        }
      } catch (e) {
        console.error("Error handling message:", e);
      }
    };

    socket.onclose = (event) => {
      console.log('WebSocket closed:', event.code, event.reason);
      statusDiv.textContent = "Connection closed.";
      if (userVisualization) { userVisualization.cancel(); userVisualization = null; }
      if (assistantVisualization) { assistantVisualization.cancel(); assistantVisualization = null; }
      cleanupAudio();
      speedSlider.disabled = true;
    };

    socket.onerror = (err) => {
      console.error('WebSocket error:', err);
      statusDiv.textContent = "Connection error.";
      if (userVisualization) { userVisualization.cancel(); userVisualization = null; }
      if (assistantVisualization) { assistantVisualization.cancel(); assistantVisualization = null; }
      cleanupAudio();
      speedSlider.disabled = true;
    };

  } catch (err) {
    statusDiv.textContent = "Microphone access denied.";
    console.error(err);
  }
};

document.getElementById("stopBtn").onclick = () => {
  if (audioProcessor) {
    audioProcessor.disconnect();
    audioProcessor = null;
  }
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.close();
  }
  if (userVisualization) { userVisualization.cancel(); userVisualization = null; }
  if (assistantVisualization) { assistantVisualization.cancel(); assistantVisualization = null; }
  cleanupAudio();
  statusDiv.textContent = "Stopped.";
};

// First render
renderMessages();

// Add resampling function
function resampleAudio(inputData, fromSampleRate, toSampleRate) {
  const ratio = fromSampleRate / toSampleRate;
  const newLength = Math.round(inputData.length / ratio);
  const result = new Float32Array(newLength);
  
  for (let i = 0; i < newLength; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    
    if (index + 1 < inputData.length) {
      result[i] = inputData[index] * (1 - fraction) + inputData[index + 1] * fraction;
    } else {
      result[i] = inputData[index];
    }
  }
  
  return result;
}

function visualize(analyserNode, bars) {
  console.log("visualize function called.");

  // Stop the CSS animation so it doesn't interfere with the JS visualization.
  bars.forEach(bar => {
    bar.style.animation = 'none';
  });

  const bufferLength = analyserNode.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  let animationFrameId;
  let hasLoggedData = false;
  
  const draw = () => {
    animationFrameId = requestAnimationFrame(draw);
    analyserNode.getByteFrequencyData(dataArray);
    
    const sum = dataArray.reduce((a, b) => a + b, 0);
    if (sum > 0 && !hasLoggedData) {
        console.log("Visualization drawing with data for the first time:", dataArray);
        hasLoggedData = true;
    }

    bars.forEach((bar, i) => {
      const barHeight = (dataArray[i] / 255) * 1.5;
      bar.style.transform = `scaleY(${Math.max(0.05, barHeight)})`;
    });
  };
  
  draw();

  return {
    cancel: () => {
      cancelAnimationFrame(animationFrameId);
    }
  };
}
