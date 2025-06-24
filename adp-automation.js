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
  
  // Ensure we're on the welcome page
  if (!page.url().includes('/welcome')) {
    console.log('Not on welcome page, navigating...');
    await page.goto(CONFIG.urls.welcome, { waitUntil: 'networkidle2' });
  }
  
  // Wait for page to load completely
  await new Promise(resolve => setTimeout(resolve, CONFIG.delay));
  
  // Handle location permission if it pops up
  page.on('dialog', async dialog => {
    console.log('Dialog detected:', dialog.message());
    await dialog.accept();
  });
  
  const buttonText = type === 'IN' ? 'Punch In' : 'Punch Out';
  console.log(`Looking for button: "${buttonText}"`);
  
  // Try multiple methods to find and click the button
  const clicked = await page.evaluate((text) => {
    // Method 1: Exact text match
    let buttons = Array.from(document.querySelectorAll('button.mybtn'));
    let targetButton = buttons.find(button => button.textContent.trim() === text);
    
    // Method 2: Partial text match
    if (!targetButton) {
      const searchTerm = text.split(' ')[1]; // "In" or "Out"
      targetButton = buttons.find(button => 
        button.textContent.trim().includes('Punch') && 
        button.textContent.trim().includes(searchTerm)
      );
    }
    
    // Method 3: Any button containing the search term
    if (!targetButton) {
      buttons = Array.from(document.querySelectorAll('button'));
      targetButton = buttons.find(button => button.textContent.trim().includes(text));
    }
    
    if (targetButton) {
      targetButton.click();
      return true;
    }
    return false;
  }, buttonText);
  
  if (!clicked) {
    throw new Error(`Could not find or click ${buttonText} button`);
  }
  
  console.log(`Clicked ${buttonText} button`);
  
  // Wait for response
  await new Promise(resolve => setTimeout(resolve, 3000));
  
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
    return process.env.PUNCH_TYPE;
  }
  
  // Get current hour in IST (UTC + 5:30)
  const now = new Date();
  const istHour = (now.getUTCHours() + 5.5) % 24;
  
  // If before 2 PM IST, it's probably punch IN, otherwise punch OUT
  return istHour < 14 ? 'IN' : 'OUT';
}

// Set the punch type
process.env.PUNCH_TYPE = process.env.PUNCH_TYPE || determinePunchType();

// Run the automation with retry mechanism
runAutomationWithRetry();
