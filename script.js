// Elements
const fileUpload = document.getElementById('fileUpload');
const fileName = document.getElementById('fileName');
const websiteName = document.getElementById('websiteName');
const deployBtn = document.getElementById('deployBtn');
const statusMessage = document.getElementById('statusMessage');
const resultCard = document.getElementById('resultCard');
const deployedUrl = document.getElementById('deployedUrl');
const newDeployBtn = document.getElementById('newDeployBtn');
const quotaDisplay = document.getElementById('quotaDisplay');
const quotaText = document.getElementById('quotaText');

let selectedFile = null;
let cooldownTimer = null;

// API URL (ganti dengan URL API-mu)
const API_URL = '/api/deploy';
// atau jika di domain yang sama: const API_URL = '/api/deploy';

// Check quota on load
checkQuota();

async function checkQuota() {
    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                name: 'quota-check', 
                fileData: '', 
                fileName: 'check.html' 
            })
        });
        
        const data = await response.json();
        
        if (data.remainingQuota !== undefined) {
            updateQuotaDisplay(data.remainingQuota);
        }
        
        if (data.cooldown && data.remainingSeconds) {
            startCooldownTimer(data.remainingSeconds);
        }
    } catch (e) {
        quotaText.textContent = 'Quota: --/50';
    }
}

function updateQuotaDisplay(remaining) {
    quotaText.textContent = `Quota tersisa: ${remaining}/50`;
    
    if (remaining <= 0) {
        quotaDisplay.classList.add('error');
        deployBtn.disabled = true;
    } else if (remaining <= 10) {
        quotaDisplay.classList.add('warning');
    } else {
        quotaDisplay.classList.remove('warning', 'error');
    }
}

function startCooldownTimer(seconds) {
    deployBtn.disabled = true;
    
    if (cooldownTimer) clearInterval(cooldownTimer);
    
    let remaining = seconds;
    
    const updateCooldown = () => {
        const minutes = Math.floor(remaining / 60);
        const secs = remaining % 60;
        quotaText.textContent = `Cooldown: ${minutes}m ${secs}s`;
        quotaDisplay.classList.add('warning');
        
        if (remaining <= 0) {
            clearInterval(cooldownTimer);
            deployBtn.disabled = false;
            checkQuota();
        }
        remaining--;
    };
    
    updateCooldown();
    cooldownTimer = setInterval(updateCooldown, 1000);
}

// File upload handler
fileUpload.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        selectedFile = file;
        fileName.textContent = file.name;
        
        // Validate file type
        const validExtensions = ['.html', '.htm', '.zip'];
        const isValid = validExtensions.some(ext => 
            file.name.toLowerCase().endsWith(ext)
        );
        
        if (!isValid) {
            showStatus('error', 'Hanya file HTML/HTM atau ZIP yang diperbolehkan');
            selectedFile = null;
            fileName.textContent = 'Pilih file HTML atau ZIP';
            fileUpload.value = '';
        }
    }
});

// Website name validation
websiteName.addEventListener('input', (e) => {
    e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
});

// Deploy button handler
deployBtn.addEventListener('click', async () => {
    // Validate inputs
    if (!websiteName.value.trim()) {
        showStatus('error', 'Silakan masukkan nama website');
        websiteName.focus();
        return;
    }
    
    if (!selectedFile) {
        showStatus('error', 'Silakan pilih file untuk diupload');
        fileUpload.click();
        return;
    }
    
    // Start deployment
    await deployToVercel(websiteName.value.trim(), selectedFile);
});

// New deploy button
newDeployBtn.addEventListener('click', () => {
    resultCard.classList.add('hidden');
    websiteName.value = '';
    fileUpload.value = '';
    fileName.textContent = 'Pilih file HTML atau ZIP';
    selectedFile = null;
    statusMessage.classList.add('hidden');
    checkQuota();
});

// Show status message
function showStatus(type, message) {
    statusMessage.className = `status-message ${type}`;
    statusMessage.textContent = message;
    statusMessage.classList.remove('hidden');
    
    // Auto hide after 5 seconds for info messages
    if (type === 'info') {
        setTimeout(() => {
            statusMessage.classList.add('hidden');
        }, 5000);
    }
}

// ==================== FIX: BACA FILE YANG BENAR ====================
function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        
        if (file.name.toLowerCase().endsWith('.html') || 
            file.name.toLowerCase().endsWith('.htm')) {
            
            // Untuk HTML: BACA SEBAGAI TEXT
            reader.onload = function(e) {
                const text = e.target.result;
                
                // Convert text to base64
                try {
                    // Method yang paling compatible
                    const base64 = btoa(unescape(encodeURIComponent(text)));
                    resolve(base64);
                } catch (error) {
                    // Fallback method
                    const base64 = btoa(text);
                    resolve(base64);
                }
            };
            
            reader.onerror = reject;
            reader.readAsText(file, 'UTF-8');
            
        } else {
            // Untuk ZIP: BACA SEBAGAI BINARY
            reader.onload = function(e) {
                const base64 = e.target.result.split(',')[1];
                resolve(base64);
            };
            
            reader.onerror = reject;
            reader.readAsDataURL(file);
        }
    });
}

// ==================== DEPLOY KE VERCEL ====================
async function deployToVercel(name, file) {
    try {
        deployBtn.disabled = true;
        deployBtn.classList.add('loading');
        showStatus('info', 'Mempersiapkan deployment...');
        
        // Read file dengan method yang benar
        showStatus('info', 'Membaca file...');
        const fileData = await readFileAsBase64(file);
        
        // Validasi: coba decode untuk pastikan HTML valid
        if (file.name.toLowerCase().endsWith('.html') || 
            file.name.toLowerCase().endsWith('.htm')) {
            try {
                const decoded = atob(fileData);
                if (!decoded.includes('<') || !decoded.includes('>')) {
                    showStatus('warning', 'Format file mungkin tidak sesuai HTML');
                }
            } catch (e) {
                // Skip error
            }
        }
        
        // Call backend API
        showStatus('info', 'Sedang deploy ke Vercel...');
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                name: name,
                fileData: fileData,
                fileName: file.name
            })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            // Handle cooldown
            if (data.cooldown && data.remainingSeconds) {
                startCooldownTimer(data.remainingSeconds);
            }
            
            // Update quota display
            if (data.remainingQuota !== undefined) {
                updateQuotaDisplay(data.remainingQuota);
            }
            
            throw new Error(data.error || 'Deploy gagal');
        }
        
        // SUCCESS!
        deployBtn.disabled = false;
        deployBtn.classList.remove('loading');
        statusMessage.classList.add('hidden');
        
        // Update quota
        if (data.remainingQuota !== undefined) {
            updateQuotaDisplay(data.remainingQuota);
        }
        
        // Start cooldown (5 menit)
        startCooldownTimer(300);
        
        // Show result
        deployedUrl.href = data.url;
        deployedUrl.textContent = data.url.replace('https://', '');
        resultCard.classList.remove('hidden');
        
        // Auto-open website setelah 1 detik
        setTimeout(() => {
            window.open(data.url, '_blank');
        }, 1000);
        
        showStatus('success', 'Deploy berhasil! Website sedang dibuka...');
        
    } catch (error) {
        console.error('Deployment error:', error);
        showStatus('error', `Deploy gagal: ${error.message}`);
        deployBtn.disabled = false;
        deployBtn.classList.remove('loading');
    }
}

// ==================== DRAG & DROP SUPPORT ====================
document.addEventListener('DOMContentLoaded', function() {
    // Cari upload zone atau buat di body
    const uploadZone = document.querySelector('.upload-zone') || document.body;
    
    uploadZone.addEventListener('dragover', function(e) {
        e.preventDefault();
        uploadZone.style.borderColor = '#00d9ff';
        uploadZone.style.background = 'rgba(0, 217, 255, 0.05)';
    });
    
    uploadZone.addEventListener('dragleave', function() {
        uploadZone.style.borderColor = '';
        uploadZone.style.background = '';
    });
    
    uploadZone.addEventListener('drop', function(e) {
        e.preventDefault();
        uploadZone.style.borderColor = '';
        uploadZone.style.background = '';
        
        if (e.dataTransfer.files.length) {
            const file = e.dataTransfer.files[0];
            
            // Validate file type
            const validExtensions = ['.html', '.htm', '.zip'];
            const isValid = validExtensions.some(ext => 
                file.name.toLowerCase().endsWith(ext)
            );
            
            if (isValid) {
                selectedFile = file;
                fileName.textContent = file.name;
                showStatus('info', `File "${file.name}" siap di-deploy`);
            } else {
                showStatus('error', 'Hanya file HTML atau ZIP yang diizinkan');
            }
        }
    });
});

// ==================== INPUT VALIDATION ====================
websiteName.addEventListener('blur', function() {
    if (this.value && !/^[a-z0-9-]+$/.test(this.value)) {
        showStatus('error', 'Nama hanya boleh huruf kecil, angka, dan tanda hubung');
        this.focus();
    }
});

// ==================== HELPERS ====================
function bytesToSize(bytes) {
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 Byte';
    const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
    return Math.round(bytes / Math.pow(1024, i), 2) + ' ' + sizes[i];
}

// ==================== PAGE VISIBILITY ====================
document.addEventListener('visibilitychange', function() {
    if (!document.hidden) {
        checkQuota();
    }
});
