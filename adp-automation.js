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
  
  // Take initial screenshot
  await page.screenshot({ 
    path: `debug-initial-${type.toLowerCase()}.png`,
    fullPage: true 
  });
  console.log(`Initial screenshot saved: debug-initial-${type.toLowerCase()}.png`);
  
  // Ensure we're on the welcome page
  if (!page.url().includes('/welcome')) {
    console.log('Not on welcome page, navigating...');
    await page.goto(CONFIG.urls.welcome, { waitUntil: 'networkidle2' });
  }
  
  console.log('Current URL:', page.url());
  
  // Wait a bit for the page to load completely
  await new Promise(resolve => setTimeout(resolve, CONFIG.delay));
  
  // Handle location permission if it pops up
  page.on('dialog', async dialog => {
    console.log('Dialog detected:', dialog.message());
    await dialog.accept();
  });
  
  // Take screenshot after page load
  await page.screenshot({ 
    path: `debug-after-load-${type.toLowerCase()}.png`,
    fullPage: true 
  });
  console.log(`After load screenshot saved: debug-after-load-${type.toLowerCase()}.png`);
  
  // Debug: Log all buttons on the page
  const allButtons = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    return buttons.map(button => ({
      text: button.textContent.trim(),
      className: button.className,
      type: button.type,
      outerHTML: button.outerHTML.substring(0, 200) // First 200 chars
    }));
  });
  
  console.log('All buttons found on page:');
  allButtons.forEach((btn, index) => {
    console.log(`Button ${index + 1}:`, JSON.stringify(btn, null, 2));
  });
  
  // Look for the specific punch button based on type
  const buttonText = type === 'IN' ? 'Punch In' : 'Punch Out';
  console.log(`Looking for button with text: "${buttonText}"`);
  
  try {
    // Method 1: Try exact text match
    console.log('Method 1: Trying exact text match...');
    const exactMatch = await page.evaluate((text) => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const found = buttons.find(button => button.textContent.trim() === text);
      if (found) {
        console.log('Found exact match:', found.outerHTML);
        return true;
      }
      return false;
    }, buttonText);
    
    if (exactMatch) {
      console.log('Exact match found, clicking...');
      await page.evaluate((text) => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const targetButton = buttons.find(button => button.textContent.trim() === text);
        targetButton.click();
      }, buttonText);
    } else {
      // Method 2: Try partial text match
      console.log('Method 2: Trying partial text match...');
      const partialMatch = await page.evaluate((text) => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const found = buttons.find(button => button.textContent.trim().includes(text.split(' ')[1])); // Just "In" or "Out"
        if (found) {
          console.log('Found partial match:', found.outerHTML);
          return true;
        }
        return false;
      }, buttonText);
      
      if (partialMatch) {
        console.log('Partial match found, clicking...');
        await page.evaluate((text) => {
          const buttons = Array.from(document.querySelectorAll('button'));
          const targetButton = buttons.find(button => button.textContent.trim().includes(text.split(' ')[1]));
          targetButton.click();
        }, buttonText);
      } else {
        // Method 3: Try with .mybtn class specifically
        console.log('Method 3: Trying .mybtn class with text match...');
        const mybtnMatch = await page.evaluate((text) => {
          const buttons = Array.from(document.querySelectorAll('button.mybtn'));
          console.log('mybtn buttons found:', buttons.length);
          buttons.forEach((btn, i) => {
            console.log(`mybtn ${i + 1}:`, btn.textContent.trim());
          });
          const found = buttons.find(button => 
            button.textContent.trim().includes('Punch') && 
            button.textContent.trim().includes(text.split(' ')[1])
          );
          if (found) {
            console.log('Found mybtn match:', found.outerHTML);
            found.click();
            return true;
          }
          return false;
        }, buttonText);
        
        if (!mybtnMatch) {
          throw new Error(`Could not find button with text containing "${buttonText}"`);
        }
      }
    }
    
    console.log(`Clicked ${buttonText} button`);
    
    // Wait for response
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Take screenshot after clicking
    await page.screenshot({ 
      path: `debug-after-click-${type.toLowerCase()}.png`,
      fullPage: true 
    });
    console.log(`After click screenshot saved: debug-after-click-${type.toLowerCase()}.png`);
    
    // Check for success message
    const successCheck = await page.evaluate(() => {
      const bodyText = document.body.textContent.toLowerCase();
      return {
        hasSuccess: bodyText.includes('success'),
        hasSuccessful: bodyText.includes('successful'),
        bodySnippet: document.body.textContent.substring(0, 500)
      };
    });
    
    console.log('Success check result:', JSON.stringify(successCheck, null, 2));
    
    if (successCheck.hasSuccess || successCheck.hasSuccessful) {
      console.log(`Punch ${type} successful! - Success message detected`);
    } else {
      console.log(`Punch ${type} completed (no success message detected but button was clicked)`);
    }
    
  } catch (error) {
    // Take error screenshot
    await page.screenshot({ 
      path: `debug-error-${type.toLowerCase()}.png`,
      fullPage: true 
    });
    console.log(`Error screenshot saved: debug-error-${type.toLowerCase()}.png`);
    throw new Error(`Could not find or click ${buttonText} button: ${error.message}`);
  }
  
  // Take final screenshot for verification
  await page.screenshot({ 
    path: `punch-${type.toLowerCase()}-${new Date().toISOString().split('T')[0]}.png`,
    fullPage: true 
  });
  console.log(`Final screenshot saved: punch-${type.toLowerCase()}-${new Date().toISOString().split('T')[0]}.png`);
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
