const puppeteer = require('puppeteer');

const CONFIG = {
  // Updated location coordinates
  location: {
    latitude: 17.4661607,
    longitude: 78.2846192,
    accuracy: 50
  },
  // ADP SecureTime URLs
  urls: {
    login: 'https://infoservices.securtime.adp.com/login?redirectUrl=%2Fwelcome',
    welcome: 'https://infoservices.securtime.adp.com/welcome'
  },
  // Timing
  timeout: 30000,
  delay: 2000,
  maxRetries: 2
};

async function setupBrowser() {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ]
  });
  
  const page = await browser.newPage();
  
  // Set user agent to avoid detection
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  
  // Set viewport
  await page.setViewport({ width: 1366, height: 768 });
  
  // Override geolocation with your office location
  await page.setGeolocation(CONFIG.location);
  
  // Grant geolocation permission for ADP domain
  const context = browser.defaultBrowserContext();
  await context.overridePermissions('https://infoservices.securtime.adp.com', ['geolocation']);
  
  return { browser, page };
}

async function login(page) {
  console.log('Navigating to ADP SecureTime login page...');
  await page.goto(CONFIG.urls.login, { waitUntil: 'networkidle2' });
  
  // Wait for email input and fill it
  await page.waitForSelector('input[type="email"]', { timeout: CONFIG.timeout });
  await page.type('input[type="email"]', process.env.ADP_USERNAME);
  
  // Wait for password input and fill it
  await page.waitForSelector('input[type="password"]');
  await page.type('input[type="password"]', process.env.ADP_PASSWORD);
  
  // Click Sign In button
  await page.click('st-button[type="submit"] button.mybtn');
  
  // Wait for redirect to welcome page
  await page.waitForNavigation({ waitUntil: 'networkidle2' });
  console.log('Login successful - redirected to welcome page');
}

async function punchInOut(page, type) {
  console.log(`Attempting to punch ${type}...`);
  console.log(`Current URL: ${page.url()}`);
  
  // Take initial screenshot to see what we're working with
  await page.screenshot({ 
    path: `debug-before-${type.toLowerCase()}.png`,
    fullPage: true 
  });
  console.log(`Initial screenshot saved: debug-before-${type.toLowerCase()}.png`);
  
  // Navigate to welcome page (always do this to be safe)
  console.log('Navigating to welcome page...');
  await page.goto(CONFIG.urls.welcome, { waitUntil: 'networkidle2' });
  console.log(`After navigation URL: ${page.url()}`);
  
  // Wait for page to load completely
  await new Promise(resolve => setTimeout(resolve, CONFIG.delay));
  
  // Take screenshot after navigation
  await page.screenshot({ 
    path: `debug-after-nav-${type.toLowerCase()}.png`,
    fullPage: true 
  });
  console.log(`After navigation screenshot saved: debug-after-nav-${type.toLowerCase()}.png`);
  
  // Handle location permission if it pops up
  page.on('dialog', async dialog => {
    console.log('Dialog detected:', dialog.message());
    await dialog.accept();
  });
  
  const buttonText = type === 'IN' ? 'Punch In' : 'Punch Out';
  console.log(`Looking for button: "${buttonText}"`);
  
  // Debug: Check what's actually on the page
  const pageInfo = await page.evaluate(() => {
    return {
      title: document.title,
      url: window.location.href,
      bodyText: document.body ? document.body.textContent.substring(0, 500) : 'No body found',
      buttonCount: document.querySelectorAll('button').length,
      mybtnCount: document.querySelectorAll('button.mybtn').length,
      allButtons: Array.from(document.querySelectorAll('button')).map(btn => ({
        text: btn.textContent.trim(),
        className: btn.className,
        visible: btn.offsetParent !== null
      }))
    };
  });
  
  console.log('Page info:', JSON.stringify(pageInfo, null, 2));
  
  // Wait a bit more if page seems to be loading
  if (pageInfo.buttonCount === 0) {
    console.log('No buttons found, waiting additional 5 seconds...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Take another screenshot
    await page.screenshot({ 
      path: `debug-after-wait-${type.toLowerCase()}.png`,
      fullPage: true 
    });
  }
  
  // Try multiple methods to find and click the button
  const result = await page.evaluate((text) => {
    const allButtons = Array.from(document.querySelectorAll('button'));
    console.log(`Found ${allButtons.length} total buttons`);
    
    // Log all buttons for debugging
    allButtons.forEach((btn, i) => {
      console.log(`Button ${i + 1}: "${btn.textContent.trim()}" (class: ${btn.className})`);
    });
    
    // Method 1: Exact text match
    let targetButton = allButtons.find(button => button.textContent.trim() === text);
    if (targetButton) {
      console.log('Found exact match');
      targetButton.click();
      return { success: true, method: 'exact' };
    }
    
    // Method 2: Partial text match with "Punch"
    const searchTerm = text.split(' ')[1]; // "In" or "Out"
    targetButton = allButtons.find(button => 
      button.textContent.trim().includes('Punch') && 
      button.textContent.trim().includes(searchTerm)
    );
    if (targetButton) {
      console.log('Found partial match with Punch');
      targetButton.click();
      return { success: true, method: 'partial' };
    }
    
    // Method 3: Just the action word
    targetButton = allButtons.find(button => 
      button.textContent.trim().toLowerCase().includes(searchTerm.toLowerCase())
    );
    if (targetButton) {
      console.log('Found action word match');
      targetButton.click();
      return { success: true, method: 'action' };
    }
    
    return { success: false, method: 'none', buttonTexts: allButtons.map(b => b.textContent.trim()) };
  }, buttonText);
  
  console.log('Button click result:', JSON.stringify(result, null, 2));
  
  if (!result.success) {
    throw new Error(`Could not find button "${buttonText}". Available buttons: ${result.buttonTexts.join(', ')}`);
  }
  
  console.log(`Clicked ${buttonText} button using ${result.method} method`);
  
  // Wait for response
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  // Take screenshot after clicking
  await page.screenshot({ 
    path: `debug-after-click-${type.toLowerCase()}.png`,
    fullPage: true 
  });
  
  // Check for success
  const success = await page.evaluate(() => {
    const bodyText = document.body.textContent.toLowerCase();
    return bodyText.includes('success');
  });
  
  if (success) {
    console.log(`Punch ${type} successful!`);
  } else {
    console.log(`Punch ${type} completed (button clicked)`);
  }
}

async function runAutomationWithRetry() {
  const punchType = process.env.PUNCH_TYPE || 'IN'; // Default to IN instead of OUT
  let browser;
  
  for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      console.log(`Starting ADP automation attempt ${attempt}/${CONFIG.maxRetries} for punch ${punchType}...`);
      console.log(`Using location: ${CONFIG.location.latitude}, ${CONFIG.location.longitude}`);
      
      const { browser: br, page } = await setupBrowser();
      browser = br;
      
      // Handle geolocation permission proactively
      await page.evaluateOnNewDocument(() => {
        navigator.geolocation.getCurrentPosition = function(success, error) {
          success({
            coords: {
              latitude: 17.4661607,
              longitude: 78.2846192,
              accuracy: 50
            }
          });
        };
      });
      
      await login(page);
      await punchInOut(page, punchType);
      
      console.log('Automation completed successfully!');
      return; // Success - exit the retry loop
      
    } catch (error) {
      console.error(`Attempt ${attempt} failed:`, error.message);
      
      if (browser) {
        try {
          // Take error screenshot
          const page = (await browser.pages())[0];
          await page.screenshot({ 
            path: `error-attempt-${attempt}.png`,
            fullPage: true 
          });
          console.log(`Error screenshot saved: error-attempt-${attempt}.png`);
        } catch (e) {
          console.log('Could not take error screenshot');
        }
        
        await browser.close();
        browser = null;
      }
      
      if (attempt < CONFIG.maxRetries) {
        console.log(`Waiting 1 minute before retry...`);
        await new Promise(resolve => setTimeout(resolve, 60000)); // Wait 1 minute
      } else {
        console.error('All retry attempts failed!');
        process.exit(1);
      }
    }
  }
}

// Determine punch type based on time if not specified
function determinePunchType() {
  if (process.env.PUNCH_TYPE) {
    console.log(`Using environment PUNCH_TYPE: ${process.env.PUNCH_TYPE}`);
    return process.env.PUNCH_TYPE;
  }
  
  // Get current time info
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMinute = now.getUTCMinutes();
  
  console.log(`Current UTC time: ${utcHour}:${utcMinute.toString().padStart(2, '0')}`);
  
  // Convert to IST (UTC + 5:30)
  const istTime = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  const istHour = istTime.getHours();
  const istMinute = istTime.getMinutes();
  
  console.log(`Current IST time: ${istHour}:${istMinute.toString().padStart(2, '0')}`);
  
  // Schedule logic:
  // 5:00 AM UTC = 10:30 AM IST = Punch IN
  // 3:30 PM UTC = 9:00 PM IST = Punch OUT
  
  // For manual runs, decide based on IST time
  if (istHour < 12) {
    console.log('IST time is before noon - defaulting to Punch IN');
    return 'IN';
  } else {
    console.log('IST time is after noon - defaulting to Punch OUT');
    return 'OUT';
  }
}

// Set the punch type
process.env.PUNCH_TYPE = process.env.PUNCH_TYPE || determinePunchType();

// Run the automation with retry mechanism
runAutomationWithRetry();
