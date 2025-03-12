import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import { join, normalize, basename } from 'path';
import { createClient } from '@supabase/supabase-js';
import { exec } from 'child_process';
import { WebSocketServer } from 'ws';
// Import the locally vendored helper for Yjs WebSocket functionality.
// Ensure that setupWSConnection.js is located in the same folder as index.js.
import { setupWSConnection } from './setupWSConnection.js';

const app = express();
const httpServer = createServer(app);
console.log('[DEBUG] HTTP server created.');

const io = new Server(httpServer, {
  cors: {
    origin: [
      "http://localhost:5173",
      "https://frontend-part-1-74bvciivh-eldhos-projects-bf14323d.vercel.app",
      "https://frontend-part-1-gkt6lqqo9-eldhos-projects-bf14323d.vercel.app",
      "https://frontend-part-1-5gytxuo7r-eldhos-projects-bf14323d.vercel.app",
      "https://frontend-part-1-7fbdc4aqc-eldhos-projects-bf14323d.vercel.app"
    ],
    methods: ["GET", "POST"]
  }
});
console.log('[DEBUG] Socket.IO server initialized with CORS settings.');

app.use(cors());
app.use(express.json());
console.log('[DEBUG] Express middleware (CORS, JSON) applied.');

const SUPABASE_URL = 'https://zfuocdlxngsbsmdhxmbw.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpmdW9jZGx4bmdzYnNtZGh4bWJ3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTczNzg5NDY2OCwiZXhwIjoyMDUzNDcwNjY4fQ.X-dPwutCSqZT_aLCUoSXHCsyG3Ihi1Gm92aoq8wgXTg'; // Replace with your Supabase key
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
console.log('[DEBUG] Supabase client created.');

const workspaces = new Map();
console.log('[DEBUG] In-memory workspaces map created.');

// Helper: Sanitize file paths
function sanitizePath(inputPath) {
  return normalize(inputPath).replace(/^(\.\.(\/|\\|$))+/, '');
}

// Create workspace directory asynchronously
async function createWorkspaceDir(roomId) {
  const workspaceDir = join(process.cwd(), 'workspaces', roomId);
  console.log(`[DEBUG] Creating workspace directory for room "${roomId}" at ${workspaceDir}`);
  try {
    await fsPromises.mkdir(workspaceDir, { recursive: true });
    console.log(`[DEBUG] Directory created at: ${workspaceDir}`);
  } catch (err) {
    console.error(`[DEBUG] Error creating directory:`, err);
    throw err;
  }
  return workspaceDir;
}

// Recursively generate the directory structure asynchronously
async function getDirectoryStructure(dir) {
  console.log(`[DEBUG] Reading directory structure for ${dir}`);
  const structure = [];
  try {
    const items = await fsPromises.readdir(dir);
    for (const item of items) {
      const fullPath = join(dir, item);
      const stats = await fsPromises.stat(fullPath);
      if (stats.isDirectory()) {
        const children = await getDirectoryStructure(fullPath);
        structure.push({ name: item, type: 'directory', children });
      } else {
        structure.push({ name: item, type: 'file' });
      }
    }
  } catch (err) {
    console.error(`[DEBUG] Error reading directory ${dir}:`, err);
  }
  console.log(`[DEBUG] Directory structure for ${dir}:`, structure);
  return structure;
}

// Update file content using asynchronous write
async function updateFile(workspaceDir, filePath, content) {
  const sanitizedPath = sanitizePath(filePath);
  const fullPath = join(workspaceDir, sanitizedPath);
  console.log(`[DEBUG] Updating file: ${fullPath}`);
  try {
    await fsPromises.access(fullPath); // Ensure file exists
  } catch (err) {
    throw new Error(`File ${fullPath} does not exist`);
  }
  try {
    await fsPromises.writeFile(fullPath, content, 'utf8');
    console.log(`[DEBUG] File saved successfully at ${fullPath}`);
  } catch (err) {
    throw new Error(`Error writing file: ${err.message}`);
  }
}

// Create a new file or directory asynchronously
async function createFile(workspaceDir, filePath, type) {
  const sanitizedPath = sanitizePath(filePath);
  const fullPath = join(workspaceDir, sanitizedPath);
  console.log(`[DEBUG] Creating ${type} at ${fullPath}`);
  try {
    // Check if file/directory already exists
    try {
      await fsPromises.access(fullPath);
      throw new Error(`File or directory already exists at ${fullPath}`);
    } catch (err) {
      // Expected if file doesn't exist.
    }
    if (type === 'file') {
      await fsPromises.writeFile(fullPath, '', 'utf8');
    } else if (type === 'directory') {
      await fsPromises.mkdir(fullPath, { recursive: true });
    }
    console.log(`[DEBUG] Created ${type} at ${fullPath}`);
  } catch (err) {
    throw new Error(`Failed to create ${type}: ${err.message}`);
  }
}

// Socket.IO event handling
io.on('connection', (socket) => {
  console.log(`[DEBUG] New Socket.IO connection: ${socket.id}`);

  socket.on('execute-code', async ({ roomId, filePath, code }) => {
    console.log(`[DEBUG] Received execute-code event from ${socket.id} for room ${roomId}`);
    if (!workspaces.has(roomId)) {
      socket.emit('error', 'Workspace not found');
      return;
    }
    const workspaceDir = workspaces.get(roomId).dir;
    const sanitizedPath = sanitizePath(filePath);
    const fullPath = join(workspaceDir, sanitizedPath);
    try {
      await fsPromises.writeFile(fullPath, code, 'utf8');
      console.log(`[DEBUG] Code written to ${fullPath}`);
      exec(`python ${fullPath}`, { timeout: 5000 }, (error, stdout, stderr) => {
        if (error) {
          console.error(`[DEBUG] Execution error for ${fullPath}:`, error);
          socket.emit('execution-result', { filePath, output: stderr || error.message });
        } else {
          console.log(`[DEBUG] Execution output for ${fullPath}:`, stdout);
          socket.emit('execution-result', { filePath, output: stdout });
        }
      });
    } catch (err) {
      socket.emit('error', `Execution failed: ${err.message}`);
    }
  });

  socket.on('create-room', async (roomId) => {
    console.log(`[DEBUG] Create-room requested for room ${roomId} by ${socket.id}`);
    if (!workspaces.has(roomId)) {
      try {
        const workspaceDir = await createWorkspaceDir(roomId);
        workspaces.set(roomId, {
          dir: workspaceDir,
          users: new Set([socket.id])
        });
        socket.join(roomId);
        console.log(`[DEBUG] Room ${roomId} created and ${socket.id} joined.`);

        // Insert workspace record into Supabase
        const { error: workspaceError } = await supabase
          .from('workspaces')
          .insert([{ id: roomId, name: roomId, owner_id: socket.id }]);
        if (workspaceError) {
          console.error(`[DEBUG] Supabase workspace error:`, workspaceError);
          socket.emit('error', 'Failed to create workspace in database');
          return;
        }
        // Insert default file record (main.py)
        const { error: fileError } = await supabase
          .from('files')
          .insert([{
            name: 'main.py',
            path: `workspaces/${roomId}/main.py`,
            workspace_id: roomId,
            type: 'file',
            created_at: new Date()
          }]);
        if (fileError) {
          socket.emit('error', 'Failed to create main.py in database');
        }
        // Create main.py locally if it doesn't exist
        const mainPyPath = join(workspaceDir, 'main.py');
        try {
          await fsPromises.access(mainPyPath);
          console.log(`[DEBUG] main.py already exists at: ${mainPyPath}`);
        } catch (err) {
          await fsPromises.writeFile(mainPyPath, '# Write your Python code here\n', 'utf8');
          console.log(`[DEBUG] main.py created at: ${mainPyPath}`);
        }
        socket.emit('room-created', roomId);
        setTimeout(async () => {
          const updatedFiles = await getDirectoryStructure(workspaceDir);
          socket.emit('file-updated', updatedFiles);
        }, 200);
      } catch (err) {
        console.error(`[DEBUG] Error in create-room for room ${roomId}:`, err);
        socket.emit('error', err.message);
      }
    } else {
      socket.emit('error', 'Room already exists');
    }
  });

  socket.on('chat-message', async (data) => {
    console.log(`[DEBUG] Chat message received from ${socket.id} for room ${data.roomId}`);
    try {
      const { error } = await supabase
        .from('chat_messages')
        .insert([
          {
            room_id: data.roomId,
            username: data.username,
            message: data.message,
            created_at: new Date().toISOString()
          }
        ]);
      if (error) {
        console.error('[DEBUG] Supabase chat error:', error);
        socket.emit('error', 'Failed to save chat message');
      }
    } catch (err) {
      console.error('[DEBUG] Exception while inserting chat message:', err);
      socket.emit('error', 'Exception occurred while saving chat message');
    }
    io.to(data.roomId).emit('chat-message', data);
  });

  socket.on('join-room', async (roomId) => {
    console.log(`[DEBUG] Join-room requested: Room ${roomId} by ${socket.id}`);
    if (workspaces.has(roomId)) {
      socket.join(roomId);
      workspaces.get(roomId).users.add(socket.id);
      const workspaceDir = workspaces.get(roomId).dir;
      const structure = await getDirectoryStructure(workspaceDir);
      socket.emit('file-updated', structure);
      socket.emit('file-structure', structure);
      const { error } = await supabase
        .from('workspace_members')
        .insert([{ user_id: socket.id, role: "viewer", workspace_id: roomId }]);
      if (error) {
        console.error('[DEBUG] Supabase join-room error:', error);
        socket.emit('error', 'Failed to join workspace in database');
      }
      socket.emit('room-joined', roomId);
      console.log(`[DEBUG] Socket ${socket.id} joined room ${roomId}`);
    } else {
      socket.emit('error', 'Room not found');
    }
  });

  socket.on('update-file', async ({ roomId, filePath, content }) => {
    console.log(`[DEBUG] Update-file requested for room ${roomId} by ${socket.id}`);
    if (!roomId || !filePath) {
      socket.emit('error', 'Invalid file update request');
      return;
    }
    if (!workspaces.has(roomId)) {
      socket.emit('error', 'Workspace not found');
      return;
    }
    const workspaceDir = workspaces.get(roomId).dir;
    try {
      await updateFile(workspaceDir, filePath, content);
      console.log(`[DEBUG] File ${filePath} updated in room ${roomId}`);
    } catch (err) {
      socket.emit('error', err.message);
    }
  });

  socket.on('create-file', async ({ roomId, path, type }) => {
    console.log(`[DEBUG] Create-file requested for room ${roomId} by ${socket.id}`);
    if (!workspaces.has(roomId)) {
      socket.emit('error', 'Workspace not found');
      return;
    }
    const workspaceDir = workspaces.get(roomId).dir;
    try {
      await createFile(workspaceDir, path, type);
      console.log(`[DEBUG] Created ${type} at ${path} in room ${roomId}`);
      const fileName = basename(path);
      const { error } = await supabase
        .from('files')
        .insert([{ name: fileName, path: `workspaces/${roomId}/${path}`, workspace_id: roomId, type }]);
      if (error) {
        socket.emit('error', 'Failed to save file to database');
        return;
      }
      const updatedFiles = await getDirectoryStructure(workspaceDir);
      io.to(roomId).emit('file-updated', updatedFiles);
    } catch (err) {
      socket.emit('error', err.message);
    }
  });

  socket.on('fetch-files', async (roomId) => {
    console.log(`[DEBUG] Fetch-files requested for room ${roomId} by ${socket.id}`);
    if (!workspaces.has(roomId)) {
      socket.emit('error', 'Workspace not found');
      return;
    }
    const workspaceDir = workspaces.get(roomId).dir;
    const updatedFiles = await getDirectoryStructure(workspaceDir);
    socket.emit('file-updated', updatedFiles);
  });

  socket.on('fetch-file-content', async ({ roomId, filePath }) => {
    console.log(`[DEBUG] Fetch-file-content requested for room ${roomId} by ${socket.id}`);
    if (!workspaces.has(roomId)) {
      socket.emit('error', `Workspace for Room ID ${roomId} not found.`);
      return;
    }
    const workspaceDir = workspaces.get(roomId).dir;
    const sanitizedPath = sanitizePath(filePath);
    const fullPath = join(workspaceDir, sanitizedPath);
    try {
      await fsPromises.access(fullPath);
      const content = await fsPromises.readFile(fullPath, 'utf8');
      socket.emit('file-content', { filePath, content });
      console.log(`[DEBUG] Sent file content for ${filePath} in room ${roomId}`);
    } catch (err) {
      socket.emit('error', `Failed to fetch file content: ${err.message}`);
    }
  });

  socket.on('disconnect', () => {
    console.log(`[DEBUG] Socket disconnected: ${socket.id}`);
    workspaces.forEach((workspace, roomId) => {
      if (workspace.users.has(socket.id)) {
        workspace.users.delete(socket.id);
        if (workspace.users.size === 0) {
          console.log(`[DEBUG] Removing workspace for room ${roomId} as no users remain.`);
          workspaces.delete(roomId);
        }
      }
    });
  });
});

// Yjs WebSocket integration
const yjsPath = '/yjs';
console.log(`[DEBUG] Initializing Yjs WebSocket server on path ${yjsPath}`);
const wss = new WebSocketServer({ server: httpServer, path: yjsPath });

wss.on('connection', (ws, req) => {
  console.log(`[DEBUG] New Yjs WebSocket connection. Request URL: ${req.url}`);
  ws.on('error', (err) => {
    console.error(`[DEBUG] Yjs WebSocket error: ${err.message}`);
  });
  setupWSConnection(ws, req);
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`[DEBUG] Server running on port ${PORT}`);
});
