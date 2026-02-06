const AdmZip = require('adm-zip');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

// In-memory storage untuk quota dan cooldown
let deploymentData = new Map();

module.exports = async (req, res) => {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { name, fileData, fileName } = req.body;

        // ==================== QUOTA CHECK ====================
        if (name === 'quota-check') {
            const clientId = getClientId(req);
            const quotaInfo = getQuotaInfo(clientId);
            
            const response = {
                remainingQuota: quotaInfo.remaining
            };
            
            if (quotaInfo.cooldownUntil > Date.now()) {
                response.cooldown = true;
                response.remainingSeconds = Math.ceil((quotaInfo.cooldownUntil - Date.now()) / 1000);
            }
            
            return res.status(200).json(response);
        }

        // ==================== VALIDASI INPUT ====================
        if (!name || !fileData || !fileName) {
            return res.status(400).json({ error: 'Data tidak lengkap' });
        }

        if (!/^[a-z0-9-]+$/.test(name)) {
            return res.status(400).json({ 
                error: 'Nama website hanya boleh mengandung huruf kecil, angka, dan tanda hubung' 
            });
        }

        if (name.length < 3 || name.length > 50) {
            return res.status(400).json({ 
                error: 'Nama website harus 3-50 karakter' 
            });
        }

        // ==================== CEK QUOTA & COOLDOWN ====================
        const clientId = getClientId(req);
        const quotaInfo = getQuotaInfo(clientId);

        if (quotaInfo.cooldownUntil > Date.now()) {
            const remainingSeconds = Math.ceil((quotaInfo.cooldownUntil - Date.now()) / 1000);
            return res.status(429).json({
                error: 'Silakan tunggu beberapa saat sebelum deploy lagi',
                cooldown: true,
                remainingSeconds,
                remainingQuota: quotaInfo.remaining
            });
        }

        if (quotaInfo.remaining <= 0) {
            return res.status(429).json({
                error: 'Quota harian telah habis',
                remainingQuota: 0
            });
        }

        // ==================== PROSES FILE ====================
        let files = [];

        if (fileName.toLowerCase().endsWith('.zip')) {
            // Extract ZIP file
            try {
                const zipBuffer = Buffer.from(fileData, 'base64');
                const zip = new AdmZip(zipBuffer);
                const zipEntries = zip.getEntries();
                
                for (const entry of zipEntries) {
                    if (!entry.isDirectory) {
                        const filePath = entry.entryName;
                        
                        // Hanya izinkan file statis yang aman
                        if (isSafeFile(filePath)) {
                            const fileBuffer = entry.getData();
                            files.push({
                                filepath: filePath,
                                content: fileBuffer,
                                isBuffer: true
                            });
                        }
                    }
                }

                // Pastikan ada index.html di dalam ZIP
                if (!files.some(f => f.filepath.toLowerCase() === 'index.html')) {
                    return res.status(400).json({ 
                        error: 'File ZIP harus mengandung index.html' 
                    });
                }
            } catch (zipError) {
                return res.status(400).json({ 
                    error: 'File ZIP corrupt atau tidak valid' 
                });
            }
            
        } else if (fileName.toLowerCase().endsWith('.html')) {
            // Single HTML file - decode dari base64 ke string HTML
            try {
                const htmlContent = Buffer.from(fileData, 'base64').toString('utf-8');
                files.push({
                    filepath: 'index.html',
                    content: htmlContent,
                    isBuffer: false
                });
            } catch (decodeError) {
                return res.status(400).json({ 
                    error: 'File HTML tidak valid (base64 decode gagal)' 
                });
            }
        } else {
            return res.status(400).json({ 
                error: 'Format file tidak didukung. Hanya .html atau .zip' 
            });
        }

        // ==================== DEPLOY KE VERCEL ====================
        const token = process.env.VERCEL_TOKEN;
        if (!token) {
            console.error('VERCEL_TOKEN tidak ditemukan');
            return res.status(500).json({ 
                error: 'Konfigurasi server tidak lengkap. Hubungi admin.' 
            });
        }

        // Siapkan files untuk Vercel API (format base64)
        const vercelFiles = files.map(f => {
            if (f.isBuffer) {
                // Buffer -> base64
                return {
                    file: f.filepath,
                    data: f.content.toString('base64')
                };
            } else {
                // String HTML -> base64
                return {
                    file: f.filepath,
                    data: Buffer.from(f.content).toString('base64')
                };
            }
        });

        try {
            // Buat deployment via Vercel API
            const deploymentResponse = await axios.post(
                'https://api.vercel.com/v13/deployments?skipAutoDetectionConfirmation=1',
                {
                    name: name,
                    files: vercelFiles,
                    projectSettings: {
                        framework: null,
                        buildCommand: null,
                        outputDirectory: null,
                        installCommand: null
                    },
                    target: 'production'
                },
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 30000 // 30 detik timeout
                }
            );

            // ==================== UPDATE QUOTA ====================
            quotaInfo.remaining--;
            quotaInfo.lastDeployment = Date.now();
            quotaInfo.cooldownUntil = Date.now() + (5 * 60 * 1000); // 5 menit cooldown
            saveQuotaInfo(clientId, quotaInfo);

            // ==================== RESPONSE SUCCESS ====================
            const deployment = deploymentResponse.data;
            const url = deployment.url 
                ? `https://${deployment.url}` 
                : `https://${name}.vercel.app`;
            
            return res.status(200).json({
                success: true,
                url: url,
                deploymentId: deployment.id,
                remainingQuota: quotaInfo.remaining
            });

        } catch (deployError) {
            console.error('Vercel API Error:', deployError.response?.data || deployError.message);
            
            // Update quota jika error karena nama sudah dipakai
            const errorData = deployError.response?.data;
            if (errorData?.error?.code === 'name_already_exists' || 
                errorData?.error?.message?.toLowerCase().includes('already exists') ||
                errorData?.error?.message?.toLowerCase().includes('duplicate')) {
                
                quotaInfo.remaining--;
                saveQuotaInfo(clientId, quotaInfo);
                
                return res.status(400).json({
                    error: 'Nama website sudah digunakan, coba nama lain',
                    remainingQuota: quotaInfo.remaining
                });
            }

            // Error lainnya
            return res.status(500).json({ 
                error: errorData?.error?.message || 'Deployment gagal. Coba lagi nanti.' 
            });
        }

    } catch (error) {
        console.error('General error:', error);
        return res.status(500).json({ 
            error: 'Terjadi kesalahan server: ' + (error.message || 'Unknown error') 
        });
    }
};

// ==================== HELPER FUNCTIONS ====================

function getClientId(req) {
    // Gunakan IP address sebagai identifier
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || '';
    return crypto.createHash('md5').update(ip + userAgent).digest('hex');
}

function getQuotaInfo(clientId) {
    const now = Date.now();
    const today = new Date().toDateString();
    
    if (!deploymentData.has(clientId)) {
        deploymentData.set(clientId, {
            remaining: 50, // Quota harian
            lastReset: today,
            lastDeployment: null,
            cooldownUntil: 0
        });
    }
    
    const data = deploymentData.get(clientId);
    
    // Reset quota jika sudah hari baru
    if (data.lastReset !== today) {
        data.remaining = 50;
        data.lastReset = today;
        data.cooldownUntil = 0;
    }
    
    // Auto cleanup old entries (24 jam)
    const oneDayAgo = now - (24 * 60 * 60 * 1000);
    deploymentData.forEach((value, key) => {
        if ((value.lastDeployment || 0) < oneDayAgo) {
            deploymentData.delete(key);
        }
    });
    
    return data;
}

function saveQuotaInfo(clientId, info) {
    deploymentData.set(clientId, info);
}

function isSafeFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const safeExtensions = ['.html', '.htm', '.css', '.js', '.json', '.txt', '.md', 
                           '.jpg', '.jpeg', '.png', '.gif', '.svg', '.ico', '.bmp',
                           '.woff', '.woff2', '.ttf', '.eot', '.otf',
                           '.webp', '.avif', '.mp4', '.webm', '.mp3', '.wav', '.ogg',
                           '.pdf', '.xml', '.csv', '.yml', '.yaml'];
    
    // Cek extension
    if (!safeExtensions.includes(ext)) {
        return false;
    }
    
    // Cek path traversal
    if (filePath.includes('..') || filePath.includes('//') || filePath.includes('\\')) {
        return false;
    }
    
    // Cek file hidden/system (tapi izinkan beberapa file penting)
    const basename = path.basename(filePath);
    const allowedHidden = ['.htaccess', '.well-known', '.gitignore', '.env.example'];
    if (basename.startsWith('.') && !allowedHidden.includes(basename)) {
        return false;
    }
    
    // Cek file eksekusi
    const execExtensions = ['.exe', '.sh', '.bat', '.cmd', '.php', '.py', '.rb', '.pl'];
    if (execExtensions.includes(ext)) {
        return false;
    }
    
    return true;
}
