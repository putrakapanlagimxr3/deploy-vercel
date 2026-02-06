const { VercelClient } = require('@vercel/client');
const AdmZip = require('adm-zip');
const path = require('path');
const crypto = require('crypto');

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

        // Cek apakah ini request quota check
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

        // Validasi input
        if (!name || !fileData || !fileName) {
            return res.status(400).json({ error: 'Data tidak lengkap' });
        }

        // Validasi nama website
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

        // Cek quota dan cooldown berdasarkan IP atau session
        const clientId = getClientId(req);
        const quotaInfo = getQuotaInfo(clientId);

        // Cek cooldown
        if (quotaInfo.cooldownUntil > Date.now()) {
            const remainingSeconds = Math.ceil((quotaInfo.cooldownUntil - Date.now()) / 1000);
            return res.status(429).json({
                error: 'Silakan tunggu beberapa saat sebelum deploy lagi',
                cooldown: true,
                remainingSeconds,
                remainingQuota: quotaInfo.remaining
            });
        }

        // Cek quota
        if (quotaInfo.remaining <= 0) {
            return res.status(429).json({
                error: 'Quota harian telah habis',
                remainingQuota: 0
            });
        }

        // Proses file
        const projectName = name;
        
        // Decode base64
        const buffer = Buffer.from(fileData, 'base64');
        let files = [];

        if (fileName.toLowerCase().endsWith('.zip')) {
            // Extract ZIP
            const zip = new AdmZip(buffer);
            const zipEntries = zip.getEntries();
            
            for (const entry of zipEntries) {
                if (!entry.isDirectory) {
                    const filePath = entry.entryName;
                    const content = entry.getData();
                    
                    // Hanya izinkan file statis yang aman
                    if (isSafeFile(filePath)) {
                        files.push({
                            filepath: filePath,
                            content: content.toString('utf-8')
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
        } else if (fileName.toLowerCase().endsWith('.html')) {
            // Single HTML file
            files.push({
                filepath: 'index.html',
                content: buffer.toString('utf-8')
            });
        } else {
            return res.status(400).json({ 
                error: 'Format file tidak didukung. Hanya .html atau .zip' 
            });
        }

        // Inisialisasi Vercel client dengan token dari environment variable
        const token = process.env.VERCEL_TOKEN;
        if (!token) {
            console.error('VERCEL_TOKEN tidak ditemukan di environment variables');
            return res.status(500).json({ error: 'Konfigurasi server tidak lengkap. Hubungi admin.' });
        }

        const vercel = new VercelClient({ token });

        // Deploy ke Vercel
        try {
            const deployment = await vercel.createProjectDeployment({
                name: projectName,
                files,
                projectSettings: {
                    framework: 'static',
                    buildCommand: null,
                    outputDirectory: null
                }
            });

            // Kurangi quota
            quotaInfo.remaining--;
            quotaInfo.lastDeployment = Date.now();
            quotaInfo.cooldownUntil = Date.now() + (5 * 60 * 1000); // 5 menit cooldown
            saveQuotaInfo(clientId, quotaInfo);

            // Return success response
            return res.status(200).json({
                success: true,
                url: `https://${deployment.url || `${projectName}.vercel.app`}`,
                deploymentId: deployment.id,
                remainingQuota: quotaInfo.remaining
            });

        } catch (deployError) {
            console.error('Vercel deployment error:', deployError);
            
            // Jika error karena nama sudah dipakai
            if (deployError.message?.includes('already exists') || 
                deployError.message?.includes('duplicate') ||
                deployError.message?.includes('name not available')) {
                
                quotaInfo.remaining--;
                saveQuotaInfo(clientId, quotaInfo);
                
                return res.status(400).json({
                    error: 'Nama website sudah digunakan, coba nama lain',
                    remainingQuota: quotaInfo.remaining
                });
            }

            return res.status(500).json({ 
                error: 'Gagal deploy ke Vercel: ' + (deployError.message || 'Unknown error') 
            });
        }

    } catch (error) {
        console.error('General error:', error);
        return res.status(500).json({ 
            error: 'Terjadi kesalahan server: ' + error.message 
        });
    }
};

// Helper functions
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
    deploymentData.forEach((value, key) => {
        if (now - (value.lastDeployment || now) > 24 * 60 * 60 * 1000) {
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
    const safeExtensions = ['.html', '.css', '.js', '.json', '.txt', '.md', 
                           '.jpg', '.jpeg', '.png', '.gif', '.svg', '.ico',
                           '.woff', '.woff2', '.ttf', '.eot', '.webp', '.mp4',
                           '.webm', '.mp3', '.wav', '.pdf'];
    
    // Cek extension
    if (!safeExtensions.includes(ext)) {
        return false;
    }
    
    // Cek path traversal
    if (filePath.includes('..') || filePath.includes('//')) {
        return false;
    }
    
    // Cek file hidden/system (tapi izinkan .htaccess, .well-known)
    const basename = path.basename(filePath);
    if (basename.startsWith('.') && basename !== '.htaccess' && !basename.startsWith('.well-known')) {
        return false;
    }
    
    return true;
}
