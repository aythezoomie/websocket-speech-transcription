import { WebSocketServer } from 'ws';
import protobuf from 'protobufjs';
import { FileWriter } from 'wav';
import fs from 'fs/promises';
import speech from '@google-cloud/speech';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';

// Convert Windows console to UTF-8
if (process.platform === 'win32') {
  process.stdout.setEncoding('utf8');
  try {
    const execAsync = promisify(exec);
    await execAsync('chcp 65001');
  } catch (error) {
    console.warn('Warning: Could not set console code page:', error);
  }
}

// Get current file directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function isArabic(text) {
  return /[\u0600-\u06FF]/.test(text);
}

class AudioWebSocketServer {
  constructor(port) {
    this.port = port;
    this.outputFileStream1 = null;
    this.outputFileStream2 = null;
    this.messageType = null;
    this.sessionId = null;
    this.transcriptionStreams = new Map();
    this.transcriptions = new Map();
    this.isStreamActive = new Map();
    this.isDisconnecting = false;
    
    // Define output directory using __dirname
    this.outputDir = path.join(__dirname, 'output');
    this.htmlOutput = path.join(this.outputDir, 'transcription-viewer.html');
    this.jsonOutput = path.join(this.outputDir, 'transcriptions.json');
    
    // Initialize Google Cloud Speech client
    this.speechClient = new speech.SpeechClient({
      keyFilename: path.join(__dirname, 'zoomineer001-86e110ef6df2.json')
    });
  }

  async initialize() {
    // Ensure output directory exists
    await fs.mkdir(this.outputDir, { recursive: true });
    
    await this.initializeHtmlOutput();
    await fs.writeFile(this.jsonOutput, '[]', 'utf8');
    
    const root = await protobuf.load('audio.proto');
    this.messageType = root.lookupType('StreamCallSessionRequest');
    
    this.wss = new WebSocketServer({ port: this.port });
    this.setupServerHandlers();
    console.log(`WebSocket server started on port ${this.port}`);
    console.log(`HTML viewer available at: ${this.htmlOutput}`);
  }

  setupServerHandlers() {
    this.wss.on('connection', (ws) => {
      console.log('Client connected');
      this.sessionId = Date.now().toString();
      
      // Track connection state
      ws.isAlive = true;

      ws.on('message', async (message) => {
        try {
          await this.handleMessage(message);
        } catch (error) {
          console.error('Error handling message:', error);
        }
      });

      // Handle explicit close event
      ws.on('close', () => {
        console.log('WebSocket closed event received');
        this.handleDisconnection();
      });

      // Handle connection termination
      ws.on('end', () => {
        console.log('WebSocket end event received');
        this.handleDisconnection();
      });

      // Handle errors
      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        this.handleDisconnection();
      });

      // Set up ping-pong to detect disconnection
      ws.on('pong', () => {
        ws.isAlive = true;
      });
    });

    // Set up connection monitoring interval
    const interval = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
          console.log('Client connection appears dead, terminating');
          ws.terminate();
          return;
        }

        ws.isAlive = false;
        ws.ping();
      });
    }, 30000);

    // Clean up interval on server close
    this.wss.on('close', () => {
      clearInterval(interval);
    });
  }

  createTranscriptionStream(speaker) {
    if (this.isStreamActive.get(speaker)) {
      return;
    }

    const request = {
      config: {
        encoding: 'LINEAR16',
        sampleRateHertz: 16000,
        enableAutomaticPunctuation: true,
        model: 'latest_long',
        
        // Enable language detection while keeping a valid primary language
        enableSpeakerDiarization: false,
        enableLanguageIdentification: true,
        
        // Use a valid primary language code (required)
        languageCode: 'ar-SA',  // Set Arabic as primary since it's a common case
        
        // Add alternative languages
        alternativeLanguageCodes: [
          'en-US',
          // Other Arabic dialects
          'ar-AE',
          'ar-BH',
          'ar-KW',
          'ar-QA',
          'ar-OM',
          'ar-JO',
          'ar-LB',
          'ar-PS',
          'ar-EG',
          'ar-IQ'
        ],
        
        // Additional settings for improved detection
        maxAlternatives: 3,
        enableWordConfidence: true,
        useEnhanced: true,
        metadata: {
          interactionType: 'PHONE_CALL',
          microphoneDistance: 'NEARFIELD',
          originalMediaType: 'AUDIO',
          recordingDeviceType: 'PHONE_LINE'
        }
      },
      interimResults: true
    };

    try {
      const recognizeStream = this.speechClient
        .streamingRecognize(request)
        .on('error', (error) => {
          console.error(`Speaker ${speaker} transcription error:`, error);
          this.isStreamActive.set(speaker, false);
        })
        .on('data', (data) => {
          if (data.results[0] && data.results[0].languageCode) {
            console.log(`Detected language for speaker ${speaker}: ${data.results[0].languageCode}`);
          }
          this.handleTranscriptionData(speaker, data);
        })
        .on('end', () => {
          console.log(`Speaker ${speaker} transcription stream ended`);
          this.isStreamActive.set(speaker, false);
        });

      this.transcriptionStreams.set(speaker, recognizeStream);
      this.isStreamActive.set(speaker, true);
      this.transcriptions.set(speaker, []);
      
      console.log(`Created new transcription stream for speaker ${speaker}`);
    } catch (error) {
      console.error(`Error creating transcription stream for speaker ${speaker}:`, error);
      this.isStreamActive.set(speaker, false);
    }
  }

  handleMessage(message) {
    const decodedMessage = this.decodeMessage(message);
    const content = this.parseMessageContent(decodedMessage);
    return this.processContent(content);
  }

  decodeMessage(message) {
    const buffer = Buffer.from(message);
    return this.messageType.decode(buffer);
  }

  parseMessageContent(decodedMessage) {
    if (Object.hasOwn(decodedMessage, 'streamingConfig')) {
      return {
        type: 'config',
        data: decodedMessage.streamingConfig
      };
    }
    
    if (Object.hasOwn(decodedMessage, 'audioContent')) {
      return {
        type: 'audio',
        data: decodedMessage.audioContent,
        role: decodedMessage.audioContent.participant.role
      };
    }
    
    if (Object.hasOwn(decodedMessage, 'sessionEvent')) {
      // Check for session end event
      if (decodedMessage.sessionEvent.eventType === 2) {
        console.log('Received session end event');
        this.handleDisconnection();
      }
      return {
        type: 'event',
        data: decodedMessage.sessionEvent
      };
    }
    
    return { type: 'unknown' };
  }

  async processContent(content) {
    switch (content.type) {
      case 'config':
        this.handleConfig();
        break;
      case 'audio':
        await this.handleAudio(content);
        break;
      case 'event':
        this.handleEvent(content.data);
        break;
    }
  }

  handleConfig() {
    this.outputFileStream1 = new FileWriter(path.join(this.outputDir, `speaker1_${this.sessionId}.wav`), {
      sampleRate: 16000,
      bitDepth: 16,
      channels: 1
    });
    
    this.outputFileStream2 = new FileWriter(path.join(this.outputDir, `speaker2_${this.sessionId}.wav`), {
      sampleRate: 16000,
      bitDepth: 16,
      channels: 1
    });

    this.createTranscriptionStream(1);
    this.createTranscriptionStream(2);
  }

  async handleAudio(content) {
    const { role, data } = content;
    
    if (role === 1 && this.outputFileStream1) {
      this.outputFileStream1.write(data.audioContent);
    } else if (role === 2 && this.outputFileStream2) {
      this.outputFileStream2.write(data.audioContent);
    }

    if (!this.isStreamActive.get(role)) {
      this.createTranscriptionStream(role);
    }

    const transcriptionStream = this.transcriptionStreams.get(role);
    if (transcriptionStream && this.isStreamActive.get(role)) {
      try {
        transcriptionStream.write(data.audioContent);
      } catch (error) {
        console.error(`Error writing to transcription stream for speaker ${role}:`, error);
        this.isStreamActive.set(role, false);
      }
    }
  }

  handleEvent(eventData) {
    console.log('Processing event:', eventData);
  }

  handleTranscriptionData(speaker, data) {
    if (data.results[0] && data.results[0].alternatives[0]) {
      const result = data.results[0];
      const alternative = result.alternatives[0];
      const transcription = alternative.transcript;
      const isFinal = result.isFinal;
      const confidence = alternative.confidence;
      
      // Get language from either direct languageCode or languageIdentification
      const languageCode = result.languageCode || 
                          (result.languageIdentification && 
                           result.languageIdentification.languageCode);
      
      // Enhanced logging for debugging language detection
      if (isFinal) {
        console.log('Language Detection Details:', {
          speaker,
          detectedLanguage: languageCode,
          confidence,
          isArabic: isArabic(transcription),
          textLength: transcription.length,
          hasLanguageIdentification: !!result.languageIdentification,
          timestamp: new Date().toISOString()
        });
      }
  
      if (isFinal) {
        this.transcriptions.get(speaker).push({
          text: transcription,
          timestamp: new Date().toISOString(),
          confidence,
          languageCode,
          languageConfidence: result.languageIdentification?.confidence || 1.0,
          isArabic: isArabic(transcription)
        });
      }
  
      const displayText = isArabic(transcription) ? 
        `\u202B${transcription}\u202C` : 
        transcription;
  
      console.log(
        `Speaker ${speaker} ${isFinal ? '(Final)' : '(Interim)'}: ` +
        `[${languageCode || 'unknown'}] ${displayText}`
      );
  
      if (isFinal) {
        this.updateTranscriptionsJson(
          speaker, 
          transcription, 
          isFinal, 
          languageCode
        );
      }
    }
  }

  async updateTranscriptionsJson(speaker, transcription, isFinal, languageCode) {
    try {
      let transcriptions = [];
      try {
        const content = await fs.readFile(this.jsonOutput, 'utf8');
        transcriptions = JSON.parse(content);
      } catch (error) {
        console.error('Error reading transcriptions.json:', error);
        transcriptions = [];
      }

      transcriptions.push({
        id: Date.now().toString(),
        speaker,
        text: transcription,
        timestamp: new Date().toISOString(),
        isFinal,
        languageCode,
        isArabic: isArabic(transcription)
      });

      if (transcriptions.length > 100) {
        transcriptions = transcriptions.slice(-100);
      }

      await fs.writeFile(this.jsonOutput, JSON.stringify(transcriptions, null, 2), 'utf8');
    } catch (error) {
      console.error('Error updating transcriptions.json:', error);
    }
  }

  async handleDisconnection() {
    if (this.isDisconnecting) {
      return;
    }
    this.isDisconnecting = true;

    console.log('Starting disconnection handling...');
    
    for (const [speaker, stream] of this.transcriptionStreams.entries()) {
      if (stream && this.isStreamActive.get(speaker)) {
        try {
          console.log(`Ending transcription stream for speaker ${speaker}`);
          stream.end();
          this.isStreamActive.set(speaker, false);
        } catch (error) {
          console.error(`Error ending transcription stream for speaker ${speaker}:`, error);
        }
      }
    }

    console.log('Closing audio file streams...');
    if (this.outputFileStream1) {
      this.outputFileStream1.end();
    }
    if (this.outputFileStream2) {
      this.outputFileStream2.end();
    }

    try {
      console.log('Saving transcriptions and combining audio...');
      await Promise.all([
        this.saveTranscriptions(),
        this.combineAudioFiles()
      ]);

      console.log('Cleaning up files...');
      await this.cleanupFiles();
      
      console.log('Disconnection handling completed');
    } catch (error) {
      console.error('Error during disconnection cleanup:', error);
    } finally {
      this.isDisconnecting = false;
    }
  }

  async saveTranscriptions() {
    const transcriptionFile = path.join(this.outputDir, `transcription_${this.sessionId}.txt`);
    let content = '\ufeff' + 'Call Transcription\n==================\n\n';

    const allTranscriptions = [];
    for (const [speaker, speakerTranscriptions] of this.transcriptions.entries()) {
      speakerTranscriptions.forEach(t => {
        allTranscriptions.push({
          speaker,
          ...t
        });
      });
    }

    allTranscriptions.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    allTranscriptions.forEach(t => {
      const text = isArabic(t.text) ? 
        `\u202B${t.text}\u202C` : 
        t.text;

      content += `[${t.timestamp}] Speaker ${t.speaker} (${(t.confidence * 100).toFixed(1)}% confidence`;
      if (t.languageCode) {
        content += `, Language: ${t.languageCode}`;
      }
      content += `):\n${text}\n\n`;
    });

    await fs.writeFile(transcriptionFile, content, 'utf8');
    console.log(`Transcription saved to ${transcriptionFile}`);
  }

  async combineAudioFiles() {
    const speaker1File = `speaker1_${this.sessionId}.wav`;
    const speaker2File = `speaker2_${this.sessionId}.wav`;
    const outputFile = path.join(this.outputDir, `combined_${this.sessionId}.wav`);

    try {
      const [audioData1, audioData2] = await Promise.all([
        this.readWavFile(speaker1File),
        this.readWavFile(speaker2File)
      ]);

      const writer = new FileWriter(outputFile, {
        channels: 2,
        sampleRate: 16000,
        bitDepth: 16
      });

      const samplesPerChannel = Math.min(
        audioData1.length / 2,
        audioData2.length / 2
      );

      const stereoBuffer = Buffer.alloc(samplesPerChannel * 4);

      for (let i = 0; i < samplesPerChannel; i++) {
        const sample1 = audioData1.readInt16LE(i * 2);
        const sample2 = audioData2.readInt16LE(i * 2);
        
        const leftChannel = Math.floor(
          (sample1 * 0.60) +
          (sample2 * 0.40)
        );

        const rightChannel = Math.floor(
          (sample1 * 0.40) +
          (sample2 * 0.60)
        );

        const clampedLeft = Math.max(-32768, Math.min(32767, leftChannel));
        const clampedRight = Math.max(-32768, Math.min(32767, rightChannel));

        stereoBuffer.writeInt16LE(clampedLeft, i * 4);
        stereoBuffer.writeInt16LE(clampedRight, i * 4 + 2);
      }

      writer.write(stereoBuffer);

      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
        writer.end();
      });

      console.log('Successfully combined audio files into stereo with balanced panning');
      return outputFile;

    } catch (error) {
      console.error('Error combining audio files:', error);
    }
  }

  async readWavFile(filename) {
    const filePath = path.join(this.outputDir, filename);
    const audioData = await fs.readFile(filePath);
    return audioData.slice(44); // Skip WAV header
  }

  async cleanupFiles() {
    const filesToClean = [
      path.join(this.outputDir, `speaker1_${this.sessionId}.wav`),
      path.join(this.outputDir, `speaker2_${this.sessionId}.wav`)
    ];

    for (const file of filesToClean) {
      try {
        await fs.unlink(file);
        console.log(`Cleaned up file: ${file}`);
      } catch (error) {
        console.error(`Error cleaning up file ${file}:`, error);
      }
    }

    this.outputFileStream1 = null;
    this.outputFileStream2 = null;
  }

  async initializeHtmlOutput() {
    const htmlTemplate = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Live Transcription Viewer</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            margin: 20px;
            background-color: #f5f5f5;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
            background-color: white;
            padding: 20px;
            border-radius: 10px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .header {
            text-align: center;
            margin-bottom: 20px;
            padding-bottom: 20px;
            border-bottom: 1px solid #eee;
        }
        .transcription {
            margin: 15px 0;
            padding: 15px;
            border: 1px solid #eee;
            border-radius: 5px;
            transition: background-color 0.3s;
        }
        .transcription:hover {
            background-color: #f9f9f9;
        }
        .metadata {
            font-size: 0.9em;
            color: #666;
            margin-bottom: 5px;
        }
        .text {
            font-size: 1.1em;
            line-height: 1.4;
        }
        .arabic {
            direction: rtl;
            font-family: 'Traditional Arabic', 'Arabic Typesetting', 'Arial', sans-serif;
            font-size: 1.3em;
        }
        .auto-refresh {
            margin: 20px 0;
            text-align: center;
        }
        .status {
            position: fixed;
            top: 10px;
            right: 10px;
            padding: 5px 10px;
            background-color: #4CAF50;
            color: white;
            border-radius: 5px;
            font-size: 0.8em;
        }
    </style>
    <script>
        let isAutoRefresh = true;

        function toggleAutoRefresh() {
            isAutoRefresh = !isAutoRefresh;
            document.getElementById('autoRefreshStatus').textContent = 
                isAutoRefresh ? 'Auto-refresh: ON' : 'Auto-refresh: OFF';
        }

        function updateTimestamp() {
            const status = document.getElementById('lastUpdate');
            status.textContent = 'Last update: ' + new Date().toLocaleTimeString();
        }

        function refreshContent() {
            if (!isAutoRefresh) return;
            
            const transcriptionsDiv = document.getElementById('transcriptions');
            const lastTranscription = transcriptionsDiv.lastElementChild;
            const lastTimestamp = lastTranscription ? 
                lastTranscription.getAttribute('data-timestamp') : '';

            fetch('transcriptions.json?' + new Date().getTime())
                .then(response => response.json())
                .then(data => {
                    let hasNewContent = false;
                    // Filter only final transcriptions
                    const finalTranscriptions = data.filter(t => t.isFinal);
                    
                    finalTranscriptions.forEach(transcription => {
                        const existingElement = document.querySelector(
                            \`[data-id="\${transcription.id}"]\`
                        );
                        
                        if (!existingElement) {
                            hasNewContent = true;
                            const div = document.createElement('div');
                            div.className = \`transcription \${transcription.isArabic ? 'arabic' : ''}\`;
                            div.setAttribute('data-id', transcription.id);
                            div.setAttribute('data-timestamp', transcription.timestamp);
                            
                            div.innerHTML = \`
                                <div class="metadata">
                                    [\${new Date(transcription.timestamp).toLocaleTimeString()}] 
                                    Speaker \${transcription.speaker}
                                    \${transcription.languageCode ? \` - \${transcription.languageCode}\` : ''}
                                </div>
                                <div class="text">\${transcription.text}</div>
                            \`;
                            
                            transcriptionsDiv.appendChild(div);
                        }
                    });

                    if (hasNewContent) {
                        transcriptionsDiv.scrollTop = transcriptionsDiv.scrollHeight;
                        updateTimestamp();
                    }
                });
        }

        // Start auto-refresh when page loads
        document.addEventListener('DOMContentLoaded', () => {
            setInterval(refreshContent, 1000);
            updateTimestamp();
        });
    </script>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Live Transcription Viewer</h1>
            <div class="auto-refresh">
                <button onclick="toggleAutoRefresh()">Toggle Auto-refresh</button>
                <span id="autoRefreshStatus">Auto-refresh: ON</span>
            </div>
        </div>
        <div id="transcriptions"></div>
    </div>
    <div id="lastUpdate" class="status">Last update: Never</div>
</body>
</html>`;

    await fs.writeFile(this.htmlOutput, htmlTemplate, 'utf8');
  }
}

// Usage
const server = new AudioWebSocketServer(8003);
server.initialize().catch(console.error);