import { WebSocketServer } from 'ws';
import protobuf from 'protobufjs';
import { FileWriter, Reader } from 'wav';
import fs from 'fs/promises';
import { createReadStream } from 'fs';

class AudioWebSocketServer {
  constructor(port) {
    this.port = port;
    this.outputFileStream1 = null;
    this.outputFileStream2 = null;
    this.messageType = null;
    this.sessionId = null;
  }

  async initialize() {
    const root = await protobuf.load('audio.proto');
    this.messageType = root.lookupType('StreamCallSessionRequest');
    
    this.wss = new WebSocketServer({ port: this.port });
    this.setupServerHandlers();
    console.log(`WebSocket server started on port ${this.port}`);
  }

  setupServerHandlers() {
    this.wss.on('connection', (ws) => {
      console.log('Client connected');
      this.sessionId = Date.now().toString();
      ws.on('message', (message) => this.handleMessage(message));
      ws.on('close', () => this.handleDisconnection());
    });
  }

  handleMessage(message) {
    const decodedMessage = this.decodeMessage(message);
    const content = this.parseMessageContent(decodedMessage);
    this.processContent(content);
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
      return {
        type: 'event',
        data: decodedMessage.sessionEvent
      };
    }
    
    return { type: 'unknown' };
  }

  processContent(content) {
    switch (content.type) {
      case 'config':
        this.handleConfig();
        break;
      case 'audio':
        this.handleAudio(content);
        break;
      case 'event':
        this.handleEvent(content.data);
        break;
    }
  }

  handleConfig() {
    this.outputFileStream1 = new FileWriter(`speaker1_${this.sessionId}.wav`, {
      sampleRate: 16000,
      bitDepth: 16,
      channels: 1
    });
    
    this.outputFileStream2 = new FileWriter(`speaker2_${this.sessionId}.wav`, {
      sampleRate: 16000,
      bitDepth: 16,
      channels: 1
    });
  }

  handleAudio(content) {
    if (content.role === 1 && this.outputFileStream1) {
      this.outputFileStream1.write(content.data.audioContent);
    } else if (content.role === 2 && this.outputFileStream2) {
      this.outputFileStream2.write(content.data.audioContent);
    }
  }

  handleEvent(eventData) {
    console.log('Processing event:', eventData);
  }

  async handleDisconnection() {
    console.log('Client disconnected');
    
    // Close both file streams
    await new Promise((resolve) => {
      if (this.outputFileStream1) {
        this.outputFileStream1.end();
      }
      if (this.outputFileStream2) {
        this.outputFileStream2.end();
      }
      // Wait a bit for files to be properly closed
      setTimeout(resolve, 1000);
    });

    // Combine audio files
    await this.combineAudioFiles();

    // Clean up individual files
    await this.cleanupFiles();
  }

  async readWavFile(filename) {
    const audioData = await fs.readFile(filename);
    // Skip WAV header (44 bytes) to get just the audio data
    return audioData.slice(44);
  }

  async combineAudioFiles() {
    const speaker1File = `speaker1_${this.sessionId}.wav`;
    const speaker2File = `speaker2_${this.sessionId}.wav`;
    const outputFile = `combined_${this.sessionId}.wav`;

    try {
      // Read both audio files
      const [audioData1, audioData2] = await Promise.all([
        this.readWavFile(speaker1File),
        this.readWavFile(speaker2File)
      ]);

      // Create output file
      const writer = new FileWriter(outputFile, {
        channels: 2,
        sampleRate: 16000,
        bitDepth: 16
      });

      // Calculate the length of the shorter file
      const samplesPerChannel = Math.min(
        audioData1.length / 2,  // divide by 2 because each sample is 2 bytes
        audioData2.length / 2
      );

      // Create stereo buffer
      const stereoBuffer = Buffer.alloc(samplesPerChannel * 4);  // 4 bytes per stereo sample

      // Panning coefficients (0.75 and 0.25 create a 75%/25% mix for each channel)
      const speaker1LeftVol = 0.60;   // Speaker 1 is 75% in left, 25% in right
      const speaker1RightVol = 0.40;
      const speaker2LeftVol = 0.40;   // Speaker 2 is 25% in left, 75% in right
      const speaker2RightVol = 0.60;

      // Combine samples with balanced panning
      for (let i = 0; i < samplesPerChannel; i++) {
        const sample1 = audioData1.readInt16LE(i * 2);
        const sample2 = audioData2.readInt16LE(i * 2);
        
        // Mix left channel
        const leftChannel = Math.floor(
          (sample1 * speaker1LeftVol) + 
          (sample2 * speaker2LeftVol)
        );

        // Mix right channel
        const rightChannel = Math.floor(
          (sample1 * speaker1RightVol) + 
          (sample2 * speaker2RightVol)
        );

        // Clamp values to prevent overflow
        const clampedLeft = Math.max(-32768, Math.min(32767, leftChannel));
        const clampedRight = Math.max(-32768, Math.min(32767, rightChannel));

        // Write the mixed samples
        stereoBuffer.writeInt16LE(clampedLeft, i * 4);
        stereoBuffer.writeInt16LE(clampedRight, i * 4 + 2);
      }

      // Write the combined buffer
      writer.write(stereoBuffer);
      writer.end();

      // Wait for the writer to finish
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      console.log('Successfully combined audio files into stereo with balanced panning');

    } catch (error) {
      console.error('Error combining audio files:', error);
    }
  }

  async cleanupFiles() {
    const speaker1File = `speaker1_${this.sessionId}.wav`;
    const speaker2File = `speaker2_${this.sessionId}.wav`;

    try {
      await fs.unlink(speaker1File);
      await fs.unlink(speaker2File);
    } catch (err) {
      console.error('Error cleaning up files:', err);
    }

    this.outputFileStream1 = null;
    this.outputFileStream2 = null;
  }
}

// Usage
const server = new AudioWebSocketServer(8003);
server.initialize().catch(console.error);