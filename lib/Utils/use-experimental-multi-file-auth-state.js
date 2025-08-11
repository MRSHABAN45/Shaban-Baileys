"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.useExperimentalMultiFileAuthState = void 0;
const async_lock_1 = __importDefault(require("async-lock"));
const promises_1 = require("fs/promises");
const fs_1 = require("fs");
const path_1 = require("path");
const WAProto_1 = require("../../WAProto");
const auth_utils_1 = require("./auth-utils");
const generics_1 = require("./generics");
const node_cache_1 = __importDefault(require("node-cache"));
const Defaults_1 = require("../Defaults");

// Enhanced locking mechanism
const fileLock = new async_lock_1.default({ 
    maxPending: Infinity,
    timeout: 5000 // 5s timeout to prevent deadlocks
});
const globalAuthLock = new async_lock_1.default(); // Additional global lock

// Debugging utilities
let AUTH_DEBUG = false;
function authDebug(...args) {
    if (AUTH_DEBUG) {
        console.log('[AUTH DEBUG]', new Date().toISOString(), ...args);
    }
}

// Maximum number of backup files to keep
const MAX_BACKUPS = 5;

/**
 * Enhanced multi-file auth state storage with:
 * - Better error handling
 * - Additional locking
 * - Data validation
 * - Auto-repair mechanisms
 * - File backup and rotation
 * - Integrity checking
 */
const useExperimentalMultiFileAuthState = async (folder, options = {}) => {
    AUTH_DEBUG = options.authDebug ?? false;
    const cache = options.syncCache ? new node_cache_1.default({
      stdTTL: Defaults_1.DEFAULT_CACHE_TTLS.SIGNAL_STORE,
      useClones: false,
      deleteOnExpire: true,
      checkperiod: 120
    }) : null;
    
    // Track stats for monitoring
    const stats = {
        readSuccess: 0,
        readFailure: 0,
        writeSuccess: 0,
        writeFailure: 0,
        recoveryAttempts: 0,
        recoverySuccess: 0
    };
    
    // Validate and prepare folder
    const prepareFolder = async () => {
        try {
            const folderInfo = await (0, promises_1.stat)(folder).catch(() => null);
            
            if (folderInfo) {
                if (!folderInfo.isDirectory()) {
                    throw new Error(`Path exists but is not a directory: ${folder}`);
                }
            } else {
                authDebug('Creating auth folder:', folder);
                await (0, promises_1.mkdir)(folder, { recursive: true });
            }
            
            // Create backups folder
            const backupFolder = (0, path_1.join)(folder, 'backups');
            if (!(await (0, promises_1.stat)(backupFolder).catch(() => null))) {
                await (0, promises_1.mkdir)(backupFolder, { recursive: true });
            }
            
            // Verify folder is writable
            await testFolderAccess();
        } catch (error) {
            authDebug('Folder preparation failed:', error);
            throw new Error(`Auth folder initialization failed: ${error.message}`);
        }
    };

    const testFolderAccess = async () => {
        const testFile = (0, path_1.join)(folder, '.temp_test');
        try {
            await (0, promises_1.writeFile)(testFile, 'test');
            await (0, promises_1.unlink)(testFile);
        } catch (error) {
            throw new Error(`Folder not writable: ${error.message}`);
        }
    };

    const fixFileName = (file) => {
        if (!file) return file;
        return file.replace(/\//g, '__').replace(/:/g, '-');
    };
    
    function getUniqueId(type, id) {
        return `${type}.${id}`;
    }
    
    // Create backup of important files
    const backupFile = async (file) => {
        if (file !== 'creds.json' && !file.startsWith('app-state-sync-key')) {
            return; // Only backup critical files
        }
        
        const filePath = (0, path_1.join)(folder, fixFileName(file));
        const backupFolder = (0, path_1.join)(folder, 'backups');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = (0, path_1.join)(backupFolder, `${fixFileName(file)}.${timestamp}`);
        
        try {
            // Check if source file exists
            await (0, promises_1.access)(filePath, fs_1.constants.R_OK);
            
            // Copy file to backup location
            await (0, promises_1.copyFile)(filePath, backupPath);
            authDebug(`Backup created: ${backupPath}`);
            
            // Rotate backups (keep only the last MAX_BACKUPS)
            await rotateBackups(file);
        } catch (error) {
            if (error.code !== 'ENOENT') { // Ignore missing files
                authDebug(`Backup failed for ${file}:`, error);
            }
        }
    };
    
    // Rotate backups to prevent excessive disk usage
    const rotateBackups = async (filePattern) => {
        try {
            const backupFolder = (0, path_1.join)(folder, 'backups');
            const files = await (0, promises_1.readdir)(backupFolder);
            
            // Filter files matching the pattern
            const matchingFiles = files.filter(f => f.startsWith(fixFileName(filePattern)));
            
            // Sort by modification time (newest first)
            const sortedFiles = await Promise.all(matchingFiles.map(async file => {
                const stat = await (0, promises_1.stat)((0, path_1.join)(backupFolder, file));
                return { file, mtime: stat.mtime };
            }));
            sortedFiles.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
            
            // Delete old backups
            if (sortedFiles.length > MAX_BACKUPS) {
                for (let i = MAX_BACKUPS; i < sortedFiles.length; i++) {
                    const filePath = (0, path_1.join)(backupFolder, sortedFiles[i].file);
                    await (0, promises_1.unlink)(filePath);
                    authDebug(`Deleted old backup: ${sortedFiles[i].file}`);
                }
            }
        } catch (error) {
            authDebug('Error rotating backups:', error);
        }
    };
    
    // Validate JSON data
    const validateJSON = (data) => {
        if (!data || typeof data !== 'string') {
            return false;
        }
        
        try {
            // Try to parse the data to validate it's proper JSON
            JSON.parse(data);
            return true;
        } catch (error) {
            return false;
        }
    };

    // Enhanced write with retries, validation and atomic writes
    const writeData = async (data, file) => {
        return globalAuthLock.acquire('write', async () => {
            const filePath = (0, path_1.join)(folder, fixFileName(file));
            const tempPath = `${filePath}.tmp`;
            let attempts = 0;
            const maxAttempts = 3;
            
            // Validate data before attempting write
            try {
                // Test serialize first
                const serialized = JSON.stringify(data, generics_1.BufferJSON.replacer);
                // Try parsing back to validate
                JSON.parse(serialized);
            } catch (err) {
                authDebug(`Invalid data prevented write to ${file}:`, err);
                stats.writeFailure++;
                throw new Error(`Data validation failed: ${err.message}`);
            }
            
            // Backup existing file before modifying
            await backupFile(file);
            
            while (attempts < maxAttempts) {
                attempts++;
                try {
                    await fileLock.acquire(filePath, async () => {
                        const serialized = JSON.stringify(data, generics_1.BufferJSON.replacer);
                        
                        // Write to temp file first
                        await (0, promises_1.writeFile)(tempPath, serialized);
                        
                        // Validate the written data
                        const writtenContent = await (0, promises_1.readFile)(tempPath, { encoding: 'utf-8' });
                        if (!validateJSON(writtenContent)) {
                            throw new Error('Data validation after write failed');
                        }
                        
                        // Rename temp file to target file (atomic operation)
                        await (0, promises_1.rename)(tempPath, filePath);
                        
                        authDebug('Write successful:', file);
                        stats.writeSuccess++;
                    });
                    return;
                } catch (error) {
                    authDebug(`Write attempt ${attempts} failed for ${file}:`, error);
                    
                    // Clean up temp file if it exists
                    try {
                        await (0, promises_1.unlink)(tempPath).catch(() => {});
                    } catch {}
                    
                    if (attempts >= maxAttempts) {
                        stats.writeFailure++;
                        throw new Error(`Failed to write after ${maxAttempts} attempts: ${error.message}`);
                    }
                    await new Promise(resolve => setTimeout(resolve, 100 * attempts));
                }
            }
        });
    };

    // Try to recover file from backups
    const recoverFromBackup = async (file) => {
        stats.recoveryAttempts++;
        const backupFolder = (0, path_1.join)(folder, 'backups');
        const targetPath = (0, path_1.join)(folder, fixFileName(file)); 
        
        try {
            const files = await (0, promises_1.readdir)(backupFolder);
            
            // Find all backups for this file
            const backups = files.filter(f => f.startsWith(fixFileName(file)));
            
            if (backups.length === 0) {
                return null;
            }
            
            // Sort by modification time (newest first)
            const sortedBackups = await Promise.all(backups.map(async backupFile => {
                const backupPath = (0, path_1.join)(backupFolder, backupFile);
                const stat = await (0, promises_1.stat)(backupPath);
                return { file: backupFile, path: backupPath, mtime: stat.mtime };
            }));
            sortedBackups.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
            
            // Try each backup until we find a valid one
            for (const backup of sortedBackups) {
                try {
                    const content = await (0, promises_1.readFile)(backup.path, { encoding: 'utf-8' });
                    
                    // Validate backup content
                    if (!validateJSON(content)) {
                        authDebug(`Backup ${backup.file} is corrupted, trying next...`);
                        continue;
                    }
                    
                    // Parse and validate structure
                    const parsed = JSON.parse(content, generics_1.BufferJSON.reviver);
                    if (file === 'creds.json' && !parsed.me) {
                        authDebug(`Backup ${backup.file} has invalid structure, trying next...`);
                        continue;
                    }
                    
                    // Restore backup to original location
                    await (0, promises_1.writeFile)(targetPath, content);
                    authDebug(`Successfully recovered ${file} from backup ${backup.file}`);
                    stats.recoverySuccess++;
                    
                    return parsed;
                } catch (error) {
                    authDebug(`Failed to recover from backup ${backup.file}:`, error);
                }
            }
            
            return null;
        } catch (error) {
            authDebug(`Recovery process failed for ${file}:`, error);
            return null;
        }
    };

    // Enhanced read with validation and recovery
    const readData = async (file) => {
        return globalAuthLock.acquire('read', async () => {
            const filePath = (0, path_1.join)(folder, fixFileName(file));
            
            try {
                const data = await fileLock.acquire(filePath, async () => {
                    const content = await (0, promises_1.readFile)(filePath, { encoding: 'utf-8' });
                    
                    // Basic validation of JSON structure
                    if (!content.trim().startsWith('{') || !content.trim().endsWith('}')) {
                        authDebug(`Invalid JSON structure detected in ${file}`);
                        throw new Error('Invalid JSON structure');
                    }
                    
                    authDebug('Read successful:', file);
                    return content;
                });
                
                try {
                    const parsed = JSON.parse(data, generics_1.BufferJSON.reviver);
                    
                    // Basic data validation
                    if (file === 'creds.json' && !parsed.me) {
                        authDebug('Invalid creds data detected');
                        throw new Error('Invalid creds structure');
                    }
                    
                    stats.readSuccess++;
                    return parsed;
                } catch (jsonError) {
                    authDebug(`JSON parse error in ${file}:`, jsonError);
                    stats.readFailure++;
                    
                    // Attempt recovery
                    authDebug(`Attempting to recover ${file} from backup...`);
                    const recovered = await recoverFromBackup(file);
                    if (recovered) {
                        return recovered;
                    }
                    
                    return null;
                }
            } catch (error) {
                if (error.code !== 'ENOENT') { // Ignore "file not found" errors
                    authDebug('Read error:', file, error);
                    stats.readFailure++;
                    
                    // Try to recover from backup
                    authDebug(`Attempting to recover ${file} from backup...`);
                    const recovered = await recoverFromBackup(file);
                    if (recovered) {
                        return recovered;
                    }
                }
                return null;
            }
        });
    };

    // Safe removal
    const removeData = async (file) => {
        return globalAuthLock.acquire('remove', async () => {
            const filePath = (0, path_1.join)(folder, fixFileName(file));
            
            // Backup before deleting
            await backupFile(file);
            
            try {
                await fileLock.acquire(filePath, async () => {
                    await (0, promises_1.unlink)(filePath);
                    authDebug('Removed:', file);
                });
            } catch (error) {
                if (error.code !== 'ENOENT') { // Ignore "file not found" errors
                    authDebug('Remove error:', file, error);
                }
            }
        });
    };

    // Check system health
    const checkSystemHealth = async () => {
        try {
            // Check free disk space
            const tmpFile = (0, path_1.join)(folder, '.space_check');
            try {
                // Write a 1MB file to test disk space
                const testBuffer = Buffer.alloc(1024 * 1024, 'x');
                await (0, promises_1.writeFile)(tmpFile, testBuffer);
                await (0, promises_1.unlink)(tmpFile);
            } catch (error) {
                authDebug('Possible disk space issue:', error);
                return false;
            }
            
            // Verify creds.json is readable
            const credsPath = (0, path_1.join)(folder, 'creds.json');
            try {
                await (0, promises_1.access)(credsPath, fs_1.constants.R_OK);
            } catch (error) {
                authDebug('creds.json is not accessible:', error);
                return false;
            }
            
            return true;
        } catch (error) {
            authDebug('Health check failed:', error);
            return false;
        }
    };

    // Initialize
    await prepareFolder();
    
    // Load or initialize credentials
    let creds = await readData('creds.json');
    if (!creds) {
        authDebug('No existing creds found, initializing new ones');
        creds = (0, auth_utils_1.initAuthCreds)();
        await writeData(creds, 'creds.json');
    }
    
    async function warmUpCache() {
      try {
        const files = await promises_1.readdir(folder);
        for (const file of files) {
          if (file.endsWith('.json') && file !== 'creds.json') {
            const parts = file.split('-');
            if (parts.length === 2) {
              const type = parts[0];
              const id = parts[1].replace('.json', '');
              const data = await readData(file);
              if (data) {
                cache.set(getUniqueId(type, id), data);
                authDebug(`Cache warmed: ${type}-${id}`);
              }
            }
          }
        }
      } catch (error) {
        authDebug('Cache warm-up failed:', error);
      }
    }
    
    if (cache) await warmUpCache();

    // Auto-save mechanism with integrity check
    let saveTimeout;
    const scheduleSave = () => {
       if (saveTimeout) clearTimeout(saveTimeout);
       saveTimeout = setTimeout(async () => {
           try {
               // Check system health before saving
               const isHealthy = await checkSystemHealth();
               if (!isHealthy) {
                   authDebug('System health check failed, delaying auto-save');
                   setTimeout(scheduleSave, 60000);
                   return;
               }
               
               await saveCreds().catch(error => {
                   authDebug('Auto-save failed, retrying sooner:', error);
                   setTimeout(scheduleSave, 60000);
               });
           } catch (error) {
               authDebug('Error during save scheduling:', error);
               setTimeout(scheduleSave, 60000);
           }
       }, 180000);
    };
    
    // Enhanced save function with integrity verification
    const saveCreds = async () => {
        try {
            // Create backup before saving
            await backupFile('creds.json');
            
            // Write new data
            await writeData(creds, 'creds.json');
            
            // Verify written data
            const verifyRead = await readData('creds.json');
            if (!verifyRead || !verifyRead.me) {
                throw new Error('Integrity check failed after save');
            }
            
            scheduleSave();
        } catch (error) {
            authDebug('Critical: Creds save failed:', error);
            throw error;
        }
    };
    
    // Periodic integrity check
    let integrityCheckInterval;
    const startIntegrityChecks = () => {
        if (integrityCheckInterval) clearInterval(integrityCheckInterval);
        integrityCheckInterval = setInterval(async () => {
            try {
                authDebug('Running periodic integrity check...');
                const isHealthy = await checkSystemHealth();
                if (!isHealthy) {
                    authDebug('Integrity check failed, attempting recovery...');
                    // Try to recover creds from backup
                    const recovered = await recoverFromBackup('creds.json');
                    if (recovered && recovered.me) {
                        creds = recovered;
                        await saveCreds();
                        authDebug('Recovery successful');
                    }
                }
            } catch (error) {
                authDebug('Integrity check error:', error);
            }
        }, 3600000); // Check every hour
    };
    startIntegrityChecks();
    
    // Clean shutdown handlers
    const cleanup = async () => {
        if (saveTimeout) clearTimeout(saveTimeout);
        if (integrityCheckInterval) clearInterval(integrityCheckInterval);
        await saveCreds().catch(error => {
            authDebug('Emergency save failed:', error);
        });
    };
    
    process.on('beforeExit', async () => {
        await cleanup();
    });
    
    process.on('SIGINT', async () => {
        authDebug('Received SIGINT, saving state...');
        await cleanup();
        process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
        authDebug('Received SIGTERM, saving state...');
        await cleanup();
        process.exit(0);
    });
    
    process.on('uncaughtException', async (error) => {
        authDebug('Uncaught exception, attempting emergency save:', error);
        await cleanup();
        process.exit(1);
    });
    
    // Start auto-save loop
    scheduleSave();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    
                    await Promise.all(ids.map(async (id) => {
                        let value = cache ? cache.get(getUniqueId(type, id)) : null;
                        
                        if (!value) {
                            value = await readData(`${type}-${id}.json`);
                            if (value && cache) {
                                cache.set(getUniqueId(type, id), value);
                            }
                        }
                        
                        if (type === 'app-state-sync-key' && value) {
                            try {
                                value = WAProto_1.proto.Message.AppStateSyncKeyData.fromObject(value);
                            } catch (error) {
                                authDebug('Key conversion failed:', type, id, error);
                                
                                // Try to recover from backup
                                const recovered = await recoverFromBackup(`${type}-${id}.json`);
                                if (recovered) {
                                    try {
                                        value = WAProto_1.proto.Message.AppStateSyncKeyData.fromObject(recovered);
                                    } catch {
                                        value = null;
                                    }
                                } else {
                                    value = null;
                                }
                            }
                        }
                        
                        data[id] = value;
                    }));
                    
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const file = `${category}-${id}.json`;
                            const cacheKey = getUniqueId(category, id);
                            
                            if (value) {
                                if (cache) {
                                    cache.set(cacheKey, value);
                                }
                                tasks.push(writeData(value, file));
                            } else {
                                if (cache) {
                                    cache.del(cacheKey);
                                }
                                tasks.push(removeData(file));
                            }
                        }
                    }
                    
                    try {
                        await Promise.all(tasks);
                    } catch (error) {
                        authDebug('Bulk key update failed:', error);
                        throw error;
                    }
                }
            }
        },
        saveCreds,
        // Additional maintenance API
        cleanup: async () => {
            await cleanup();
        },
        checkHealth: async () => {
            return await checkSystemHealth();
        },
        stats: () => ({ ...stats }),
        repairIfNeeded: async () => {
            const isHealthy = await checkSystemHealth();
            if (!isHealthy) {
                authDebug('Initiating system repair...');
                // Try to recover creds and essential files
                const recovered = await recoverFromBackup('creds.json');
                if (recovered && recovered.me) {
                    creds = recovered;
                    await saveCreds();
                    return true;
                }
                return false;
            }
            return true;
        },
        cache
    };
};
exports.useExperimentalMultiFileAuthState = useExperimentalMultiFileAuthState;