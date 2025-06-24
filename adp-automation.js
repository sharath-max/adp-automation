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

async function checkPageState(page) {
  const pageInfo = await page.evaluate(() => {
    return {
      title: document.title,
      url: window.location.href,
      bodyText: document.body ? document.body.textContent.substring(0, 300) : 'No body found',
      buttonCount: document.querySelectorAll('button').length,
      allButtons: Array.from(document.querySelectorAll('button')).map(btn => ({
        text: btn.textContent.trim(),
        className: btn.className,
        visible: btn.offsetParent !== null
      }))
    };
  });
  
  // Determine page state
  const hasSignIn = pageInfo.allButtons.some(btn => btn.text.includes('Sign In'));
  const hasPunchIn = pageInfo.allButtons.some(btn => btn.text.includes('Punch In'));
  const hasPunchOut = pageInfo.allButtons.some(btn => btn.text.includes('Punch Out'));
  const isOnWelcome = pageInfo.url.includes('/welcome') && !hasSignIn;
  
  return {
    ...pageInfo,
    pageState: {
      needsLogin: hasSignIn,
      onWelcomePage: isOnWelcome,
      hasPunchIn,
      hasPunchOut,
      readyToPunch: (hasPunchIn || hasPunchOut) && !hasSignIn
    }
  };
}

async function ensureCorrectPage(page, targetAction) {
  let attempts = 0;
  const maxAttempts = 3;
  
  while (attempts < maxAttempts) {
    attempts++;
    console.log(`Page check attempt ${attempts}/${maxAttempts}`);
    
    const state = await checkPageState(page);
    console.log(`Page state:`, JSON.stringify(state.pageState, null, 2));
    console.log(`Available buttons: ${state.allButtons.map(b => b.text).join(', ')}`);
    
    // Take screenshot for debugging
    await page.screenshot({ 
      path: `page-state-attempt-${attempts}.png`,
      fullPage: true 
    });
    
    if (state.pageState.needsLogin) {
      console.log('Detected login page - performing login...');
      await performLogin(page);
      await new Promise(resolve => setTimeout(resolve, 3000)); // Wait after login
      continue;
    }
    
    if (state.pageState.readyToPunch) {
      console.log('Page is ready for punching!');
      return state;
    }
    
    if (state.pageState.onWelcomePage || state.url.includes('/welcome')) {
      console.log('On welcome page but no punch buttons visible, waiting...');
      await new Promise(resolve => setTimeout(resolve, 3000));
      continue;
    }
    
    // If we're not on the right page, try to navigate
    console.log('Not on correct page, attempting navigation to welcome...');
    try {
      await page.goto(CONFIG.urls.welcome, { waitUntil: 'networkidle2' });
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      console.log('Navigation failed:', error.message);
    }
  }
  
  throw new Error('Could not get to the correct page state after multiple attempts');
}

async function performLogin(page) {
  console.log('Performing login...');
  
  // Wait for email input and fill it
  await page.waitForSelector('input[type="email"]', { timeout: CONFIG.timeout });
  
  // Clear and type email
  await page.click('input[type="email"]', { clickCount: 3 }); // Select all
  await page.type('input[type="email"]', process.env.ADP_USERNAME);
  
  // Wait for password input and fill it
  await page.waitForSelector('input[type="password"]');
  
  // Clear and type password
  await page.click('input[type="password"]', { clickCount: 3 }); // Select all
  await page.type('input[type="password"]', process.env.ADP_PASSWORD);
  
  // Click Sign In button
  await page.click('st-button[type="submit"] button.mybtn');
  
  // Wait for page to change
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
  console.log('Login completed');
}

async function punchInOut(page, type) {
  console.log(`Attempting to punch ${type}...`);
  
  // Ensure we're on the correct page and logged in
  const state = await ensureCorrectPage(page, type);
  
  const buttonText = type === 'IN' ? 'Punch In' : 'Punch Out';
  console.log(`Looking for button: "${buttonText}"`);
  
  // Check if the required button is available
  const hasRequiredButton = state.allButtons.some(btn => 
    btn.text.includes('Punch') && btn.text.includes(type === 'IN' ? 'In' : 'Out')
  );
  
  if (!hasRequiredButton) {
    throw new Error(`Required button "${buttonText}" not found on page. Available buttons: ${state.allButtons.map(b => b.text).join(', ')}`);
  }
  
  // Handle location permission if it pops up
  page.on('dialog', async dialog => {
    console.log('Dialog detected:', dialog.message());
    await dialog.accept();
  });
  
  // Try to find and click the button
  const result = await page.evaluate((text) => {
    const allButtons = Array.from(document.querySelectorAll('button'));
    console.log(`Found ${allButtons.length} total buttons`);
    
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
    throw new Error(`Could not click button "${buttonText}". Available buttons: ${result.buttonTexts.join(', ')}`);
  }
  
  console.log(`Clicked ${buttonText} button using ${result.method} method`);
  
  // Wait for response
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  // Take screenshot after clicking
  await page.screenshot({ 
    path: `success-${type.toLowerCase()}.png`,
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
      
      // Start by going to login page
      await page.goto(CONFIG.urls.login, { waitUntil: 'networkidle2' });
      
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
        console.log(`Waiting 10 seconds before retry...`);
        await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds
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
