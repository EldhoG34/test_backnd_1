import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import { join, normalize, basename } from 'path';
import { createClient } from '@supabase/supabase-js';
import { exec } from 'child_process';
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "http://localhost:5173",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

const SUPABASE_URL = 'https://zfuocdlxngsbsmdhxmbw.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpmdW9jZGx4bmdzYnNtZGh4bWJ3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTczNzg5NDY2OCwiZXhwIjoyMDUzNDcwNjY4fQ.X-dPwutCSqZT_aLCUoSXHCsyG3Ihi1Gm92aoq8wgXTg'; // Replace with your Supabase key
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// In-memory tracking of workspaces
const workspaces = new Map();

// Helper: Sanitize file paths to prevent directory traversal
function sanitizePath(inputPath) {
  return normalize(inputPath).replace(/^(\.\.(\/|\\|$))+/, '');
}

// Create workspace directory asynchronously
async function createWorkspaceDir(roomId) {
  const workspaceDir = join(process.cwd(), 'workspaces', roomId);
  try {
    await fsPromises.mkdir(workspaceDir, { recursive: true });
    console.log(`[createWorkspaceDir] Directory created at: ${workspaceDir}`);
  } catch (err) {
    console.error(`[createWorkspaceDir] Error creating directory:`, err);
    throw err;
  }
  return workspaceDir;
}

// Recursively generate the directory structure asynchronously
async function getDirectoryStructure(dir) {
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
    console.error(`[getDirectoryStructure] Error reading directory ${dir}:`, err);
  }
  return structure;
}

// Update file content using asynchronous write
async function updateFile(workspaceDir, filePath, content) {
  const sanitizedPath = sanitizePath(filePath);
  const fullPath = join(workspaceDir, sanitizedPath);
  try {
    await fsPromises.access(fullPath); // Ensure file exists
  } catch (err) {
    throw new Error(`File ${fullPath} does not exist`);
  }
  try {
    await fsPromises.writeFile(fullPath, content, 'utf8');
    console.log(`[updateFile] File saved successfully at ${fullPath}`);
  } catch (err) {
    throw new Error(`Error writing file: ${err.message}`);
  }
}

// Create a new file or directory asynchronously
async function createFile(workspaceDir, filePath, type) {
  const sanitizedPath = sanitizePath(filePath);
  const fullPath = join(workspaceDir, sanitizedPath);
  try {
    // Check if file/directory already exists
    try {
      await fsPromises.access(fullPath);
      throw new Error(`File or directory already exists at ${fullPath}`);
    } catch (err) {
      // If access fails, it means the file doesn't exist—continue
    }
    if (type === 'file') {
      await fsPromises.writeFile(fullPath, '', 'utf8');
    } else if (type === 'directory') {
      await fsPromises.mkdir(fullPath, { recursive: true });
    }
    console.log(`[createFile] Created ${type} at ${fullPath}`);
  } catch (err) {
    throw new Error(`Failed to create ${type}: ${err.message}`);
  }
}

// Socket.io event handling
io.on('connection', (socket) => {
  
// ... inside your socket.io connection handler

socket.on('execute-code', async ({ roomId, filePath, code }) => {
  if (!workspaces.has(roomId)) {
    socket.emit('error', 'Workspace not found');
    return;
  }
  const workspaceDir = workspaces.get(roomId).dir;
  const sanitizedPath = sanitizePath(filePath);
  const fullPath = join(workspaceDir, sanitizedPath);
  try {
    // Ensure the file is updated with the latest code
    await fsPromises.writeFile(fullPath, code, 'utf8');
    // Execute the Python code with a timeout for safety (5 seconds)
    exec(`python ${fullPath}`, { timeout: 5000 }, (error, stdout, stderr) => {
      if (error) {
        socket.emit('execution-result', { filePath, output: stderr || error.message });
      } else {
        socket.emit('execution-result', { filePath, output: stdout });
      }
    });
  } catch (err) {
    socket.emit('error', `Execution failed: ${err.message}`);
  }
});

  console.log(`[connection] User connected: ${socket.id}`);

  // Create Room
  socket.on('create-room', async (roomId) => {
    if (!workspaces.has(roomId)) {
      try {
        const workspaceDir = await createWorkspaceDir(roomId);
        workspaces.set(roomId, {
          dir: workspaceDir,
          users: new Set([socket.id])
        });
        socket.join(roomId);

        // Insert workspace record into Supabase
        const { error: workspaceError } = await supabase
          .from('workspaces')
          .insert([{ id: roomId, name: roomId, owner_id: socket.id }]);
        if (workspaceError) {
          console.error(`[create-room] Supabase error:`, workspaceError);
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
          console.log(`[create-room] main.py already exists at: ${mainPyPath}`);
        } catch (err) {
          await fsPromises.writeFile(mainPyPath, '# Write your Python code here\n', 'utf8');
          console.log(`[create-room] main.py created at: ${mainPyPath}`);
        }
        socket.emit('room-created', roomId);
        // Update file structure for clients after a brief delay
        setTimeout(async () => {
          const updatedFiles = await getDirectoryStructure(workspaceDir);
          socket.emit('file-updated', updatedFiles);
        }, 200);
      } catch (err) {
        console.error(`[create-room] Error:`, err);
        socket.emit('error', err.message);
      }
    } else {
      socket.emit('error', 'Room already exists');
    }
  });
  socket.on('chat-message', async (data) => {
    // data should contain: roomId, username, message, timestamp (optional)
    try {
      // Insert the message into the chat_messages table
      const { error } = await supabase
        .from('chat_messages')
        .insert([
          {
            room_id: data.roomId,
            username: data.username,
            message: data.message,
            created_at: new Date().toISOString(), // or data.timestamp if provided
          }
        ]);
      if (error) {
        console.error("Error inserting chat message into database:", error);
        socket.emit('error', 'Failed to save chat message');
      }
    } catch (err) {
      console.error("Exception while inserting chat message:", err);
      socket.emit('error', 'Exception occurred while saving chat message');
    }
    
    // Broadcast the chat message to all clients in the room
    io.to(data.roomId).emit('chat-message', data);
  });
  

  // Join Room
  socket.on('join-room', async (roomId) => {
    console.log(`[join-room] User ${socket.id} joining room: ${roomId}`);
    if (workspaces.has(roomId)) {
      socket.join(roomId);
      workspaces.get(roomId).users.add(socket.id);
      const workspaceDir = workspaces.get(roomId).dir;
      const structure = await getDirectoryStructure(workspaceDir);
// Emit file structure as 'file-updated' so that the client always catches it.
socket.emit('file-updated', structure);

      socket.emit('file-structure', structure);
      // Insert membership record into Supabase
      const { error } = await supabase
        .from('workspace_members')
        .insert([{ user_id: socket.id, role: "viewer", workspace_id: roomId }]);
      if (error) {
        console.error(`[join-room] Supabase error:`, error);
        socket.emit('error', 'Failed to join workspace in database');
      }
      socket.emit('room-joined', roomId);
      
    } else {
      socket.emit('error', 'Room not found');
    }
  });

  // Update File Content
  socket.on('update-file', async ({ roomId, filePath, content }) => {
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
    } catch (err) {
      socket.emit('error', err.message);
    }
  });

  // Create File or Directory
  socket.on('create-file', async ({ roomId, path, type }) => {
    if (!workspaces.has(roomId)) {
      socket.emit('error', 'Workspace not found');
      return;
    }
    const workspaceDir = workspaces.get(roomId).dir;
    try {
      await createFile(workspaceDir, path, type);
      // Insert record into Supabase
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

  // Fetch Files
  socket.on('fetch-files', async (roomId) => {
    if (!workspaces.has(roomId)) {
      socket.emit('error', 'Workspace not found');
      return;
    }
    const workspaceDir = workspaces.get(roomId).dir;
    const updatedFiles = await getDirectoryStructure(workspaceDir);
    socket.emit('file-updated', updatedFiles);
  });

  // Fetch File Content
  socket.on('fetch-file-content', async ({ roomId, filePath }) => {
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
    } catch (err) {
      socket.emit('error', `Failed to fetch file content: ${err.message}`);
    }
  });

  // Clean up on disconnect
  socket.on('disconnect', () => {
    workspaces.forEach((workspace, roomId) => {
      if (workspace.users.has(socket.id)) {
        workspace.users.delete(socket.id);
        if (workspace.users.size === 0) {
          workspaces.delete(roomId);
        }
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`[server] Server running on port ${PORT}`);
});
