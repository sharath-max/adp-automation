const puppeteer = require('puppeteer');

const CONFIG = {
  // Your Wipro SEZ location coordinates
  location: {
    latitude: 17.4281595,
    longitude: 78.3507877,
    accuracy: 50
  },
  // ADP SecureTime URLs
  urls: {
    login: 'https://infoservices.securtime.adp.com/login?redirectUrl=%2Fwelcome',
    welcome: 'https://infoservices.securtime.adp.com/welcome'
  },
  // Timing
  timeout: 30000,
  delay: 2000
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
    await page.goto(CONFIG.urls.welcome, { waitUntil: 'networkidle2' });
  }
  
  // Wait a bit for the page to load completely
  await page.waitForTimeout(CONFIG.delay);
  
  // Handle location permission if it pops up
  page.on('dialog', async dialog => {
    console.log('Dialog detected:', dialog.message());
    await dialog.accept();
  });
  
  // Look for the specific punch button based on type
  const buttonText = type === 'IN' ? 'Punch In' : 'Punch Out';
  const buttonSelector = `button.mybtn:has-text("${buttonText}")`;
  
  try {
    // Try to find button by text content
    await page.waitForFunction(
      (text) => {
        const buttons = Array.from(document.querySelectorAll('button.mybtn'));
        return buttons.some(button => button.textContent.trim().includes(text));
      },
      { timeout: CONFIG.timeout },
      buttonText
    );
    
    // Click the button
    await page.evaluate((text) => {
      const buttons = Array.from(document.querySelectorAll('button.mybtn'));
      const targetButton = buttons.find(button => button.textContent.trim().includes(text));
      if (targetButton) {
        targetButton.click();
        return true;
      }
      return false;
    }, buttonText);
    
    console.log(`Clicked ${buttonText} button`);
    
    // Wait for success message or page change
    await page.waitForTimeout(3000);
    
    // Check for success message
    try {
      await page.waitForFunction(
        () => document.body.textContent.includes('Success') || 
              document.body.textContent.includes('successful'),
        { timeout: 10000 }
      );
      console.log(`Punch ${type} successful! - Success message detected`);
    } catch (e) {
      console.log(`Punch ${type} completed (no success message detected but button was clicked)`);
    }
    
  } catch (error) {
    throw new Error(`Could not find or click ${buttonText} button: ${error.message}`);
  }
  
  // Take screenshot for verification
  await page.screenshot({ 
    path: `punch-${type.toLowerCase()}-${new Date().toISOString().split('T')[0]}.png`,
    fullPage: true 
  });
}

async function main() {
  const punchType = process.env.PUNCH_TYPE || 'IN';
  let browser;
  
  try {
    console.log(`Starting ADP automation for punch ${punchType}...`);
    console.log(`Using location: ${CONFIG.location.latitude}, ${CONFIG.location.longitude}`);
    
    const { browser: br, page } = await setupBrowser();
    browser = br;
    
    // Handle geolocation permission proactively
    await page.evaluateOnNewDocument(() => {
      navigator.geolocation.getCurrentPosition = function(success, error) {
        success({
          coords: {
            latitude: 17.4281595,
            longitude: 78.3507877,
            accuracy: 50
          }
        });
      };
    });
    
    await login(page);
    await punchInOut(page, punchType);
    
    console.log('Automation completed successfully!');
    
  } catch (error) {
    console.error('Automation failed:', error.message);
    process.exit(1);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// Run the automation
main();
