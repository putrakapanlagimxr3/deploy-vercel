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

// Check quota on load
checkQuota();

async function checkQuota() {
    try {
        const response = await fetch('/api/deploy', {
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
        const validExtensions = ['.html', '.zip'];
        const isValid = validExtensions.some(ext => file.name.toLowerCase().endsWith(ext));
        
        if (!isValid) {
            showStatus('error', 'Harap upload file HTML atau ZIP saja');
            selectedFile = null;
            fileName.textContent = 'Pilih file HTML atau ZIP';
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
        return;
    }
    
    if (!selectedFile) {
        showStatus('error', 'Silakan pilih file untuk diupload');
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
});

// Show status message
function showStatus(type, message) {
    statusMessage.className = `status-message ${type}`;
    statusMessage.textContent = message;
}

// Read file as base64
function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const base64 = reader.result.split(',')[1];
            resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// Deploy to Vercel via backend API
async function deployToVercel(name, file) {
    try {
        deployBtn.disabled = true;
        deployBtn.classList.add('loading');
        showStatus('info', 'Mempersiapkan deployment...');
        
        // Read file
        showStatus('info', 'Membaca file...');
        const fileData = await readFileAsBase64(file);
        
        // Call backend API
        showStatus('info', 'Sedang deploy ke Vercel...');
        const response = await fetch('/api/deploy', {
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
        
        // Success
        deployBtn.disabled = false;
        deployBtn.classList.remove('loading');
        statusMessage.classList.add('hidden');
        
        // Update quota
        if (data.remainingQuota !== undefined) {
            updateQuotaDisplay(data.remainingQuota);
        }
        
        // Start cooldown
        startCooldownTimer(300); // 5 menit
        
        // Show result
        deployedUrl.href = data.url;
        deployedUrl.textContent = data.url.replace('https://', '');
        resultCard.classList.remove('hidden');
        
    } catch (error) {
        console.error('Deployment error:', error);
        showStatus('error', `Deploy gagal: ${error.message}`);
        deployBtn.disabled = false;
        deployBtn.classList.remove('loading');
    }
}
