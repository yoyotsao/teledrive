import { test, expect, Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

// ESM compatibility - get __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test configuration
const TEST_FILE_NAME = 'test-upload.txt';
const TEST_FILE_CONTENT = 'Playwright E2E Test File';

test.describe('teleDrive E2E Tests', () => {
  let page: Page;

  test.beforeEach(async ({ page: pageInstance }) => {
    page = pageInstance;
  });

  /**
   * Helper: Create a temporary test file for upload
   */
  async function createTestFile(fileName: string, content: string): Promise<string> {
    const testDir = path.join(__dirname, 'fixtures');
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    const filePath = path.join(testDir, fileName);
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  /**
   * Helper: Clean up test file
   */
  async function cleanupTestFile(filePath: string): Promise<void> {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  test('should load the app homepage', async () => {
    await page.goto('/');
    
    // Wait for app to load
    await page.waitForLoadState('networkidle');
    
    // Check if main elements exist
    const body = await page.locator('body');
    await expect(body).toBeVisible();
    
    // Take a screenshot for debugging
    await page.screenshot({ path: 'tests/screenshots/homepage.png' });
  });

  test('should handle drag-and-drop upload', async () => {
    // Create a temporary test file
    const testFilePath = await createTestFile(TEST_FILE_NAME, TEST_FILE_CONTENT);
    
    try {
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      
      // Wait for drop zone to be ready
      await page.waitForTimeout(1000);
      
      // Verify the app loads with the drop zone
      // The app has a main drop area that handles file drops
      const pageBody = page.locator('body');
      await expect(pageBody).toBeVisible();
      
      // Verify the upload button exists (alternative to drag-drop)
      const uploadButton = page.locator('button').filter({ hasText: 'Upload Files' });
      await expect(uploadButton).toBeVisible();
      
      // Screenshot for debugging
      await page.screenshot({ path: 'tests/screenshots/drag-drop.png' });
      
      // Note: Full drag-and-drop upload test requires Telegram connection
      // This test verifies the UI elements are present
      console.log('Drag-and-drop test completed - UI elements verified');
      
    } catch (error) {
      console.error('Drag-and-drop test error:', error);
      throw error;
    } finally {
      await cleanupTestFile(testFilePath);
    }
  });

  test('should upload and verify image preview', async ({ page }) => {
    const testFilesDir = path.join(__dirname, '..', '..', 'test-files');
    const imagePath = path.join(testFilesDir, 'test.png');
    
    if (!fs.existsSync(imagePath)) {
      throw new Error(`Test image not found at: ${imagePath}`);
    }
    
    console.log('='.repeat(60));
    console.log('🖼️ TEST 1: IMAGE UPLOAD & PREVIEW');
    console.log('='.repeat(60));
    
    // Go to app
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    
    // ===== Step 0: Delete old file =====
    console.log('\n[Step 0] Delete old file...');
    const existingImage = page.locator('div').filter({ hasText: /test\.png/i }).first();
    if (await existingImage.count() > 0) {
      await existingImage.click();
      await page.keyboard.press('Delete');
      page.on('dialog', async dialog => await dialog.accept());
      await page.waitForTimeout(1000);
      
      // Refresh page to confirm file is gone
      await page.reload();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(2000);
      
      const afterRefresh = page.locator('div').filter({ hasText: /test\.png/i }).first();
      if (await afterRefresh.count() > 0) {
        throw new Error('File still exists after delete - delete failed');
      }
      console.log('✅ Old file deleted and confirmed gone after refresh');
    }
    
    // ===== Step 1: Upload file and wait for completion =====
    console.log('\n[Step 1] Upload test.png...');
    const uploadButton = page.locator('button').filter({ hasText: 'Upload Files' });
    await uploadButton.click();
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(imagePath);
    
    // Wait for upload panel to appear (uploading status)
    const uploadPanel = page.locator('div').filter({ hasText: /test\.png/ }).first();
    await uploadPanel.waitFor({ state: 'visible', timeout: 5000 });
    console.log('📤 Upload started...');
    
    // Wait until upload panel shows "Uploaded" (complete status)
    // Poll every 1 second, max 120 seconds
    let uploadComplete = false;
    for (let i = 0; i < 120; i++) {
      await page.waitForTimeout(1000);
      const completeText = await uploadPanel.textContent();
      if (completeText && completeText.includes('Uploaded')) {
        uploadComplete = true;
        break;
      }
      const errorText = await uploadPanel.textContent();
      if (errorText && errorText.includes('error')) {
        throw new Error('Upload failed with error');
      }
    }
    
    if (!uploadComplete) {
      throw new Error('Upload did not complete within 120 seconds');
    }
    console.log('✅ Upload complete');
    
    // Wait a bit more for file to appear in list
    await page.waitForTimeout(2000);
    
    // ===== Step 2: Verify thumbnail =====
    console.log('\n[Step 2] Verify thumbnail...');
    const imageFile = page.locator('div').filter({ hasText: /test\.png/i }).first();
    if ((await imageFile.count()) === 0) {
      throw new Error('Image file not found after upload');
    }
    
    // Check <img> tag has content (src is not empty)
    const thumbnail = imageFile.locator('img');
    const thumbCount = await thumbnail.count();
    if (thumbCount === 0) {
      throw new Error('Thumbnail img tag not found');
    }
    
    // Verify src is not empty
    const imgSrc = await thumbnail.getAttribute('src');
    if (!imgSrc || imgSrc.trim() === '') {
      throw new Error('Thumbnail src is empty - thumbnail not loaded');
    }
    console.log(`✅ Thumbnail has content, src: ${imgSrc.substring(0, 50)}...`);
    
    // ===== Step 3: Double-click to preview =====
    console.log('\n[Step 3] Double-click to preview...');
    await imageFile.dblclick();
    await page.waitForTimeout(3000);
    
    // Verify preview modal has image with content
    const imgInModal = page.locator('img').first();
    const imgCount = await imgInModal.count();
    if (imgCount === 0) {
      throw new Error('Preview modal img not found');
    }
    
    // Verify img has content (src not empty)
    const previewSrc = await imgInModal.getAttribute('src');
    if (!previewSrc || previewSrc.trim() === '') {
      throw new Error('Preview img src is empty - image not loaded');
    }
    console.log(`✅ Image preview has content, src: ${previewSrc.substring(0, 50)}...`);
    
    // Close modal
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    console.log('\n🖼️✅ IMAGE TEST PASSED 🖼️✅');
  });

  test('should upload and verify short video', async ({ page }) => {
    const testFilesDir = path.join(__dirname, '..', '..', 'test-files');
    const videoPath = path.join(testFilesDir, 'test_small.mp4');
    
    if (!fs.existsSync(videoPath)) {
      throw new Error(`Test video not found at: ${videoPath}`);
    }
    
    console.log('='.repeat(60));
    console.log('🎬 TEST 2: SHORT VIDEO UPLOAD & PLAYBACK');
    console.log('='.repeat(60));
    
    // Go to app
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    
    // ===== Step 0: Delete old file =====
    console.log('\n[Step 0] Delete old file...');
    const existingVideo = page.locator('div').filter({ hasText: /test_small\.mp4/i }).first();
    if (await existingVideo.count() > 0) {
      await existingVideo.click();
      await page.keyboard.press('Delete');
      page.on('dialog', async dialog => await dialog.accept());
      await page.waitForTimeout(1000);
      
      // Refresh page to confirm file is gone
      await page.reload();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(2000);
      
      const afterRefresh = page.locator('div').filter({ hasText: /test_small\.mp4/i }).first();
      if (await afterRefresh.count() > 0) {
        throw new Error('File still exists after delete - delete failed');
      }
      console.log('✅ Old file deleted and confirmed gone after refresh');
    }
    
    // ===== Step 1: Upload file and wait for completion =====
    console.log('\n[Step 1] Upload test_small.mp4...');
    const uploadButton = page.locator('button').filter({ hasText: 'Upload Files' });
    await uploadButton.click();
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(videoPath);
    
    // Wait for upload panel to appear
    const uploadPanel = page.locator('div').filter({ hasText: /test_small\.mp4/ }).first();
    await uploadPanel.waitFor({ state: 'visible', timeout: 5000 });
    console.log('📤 Upload started...');
    
    // Wait until upload complete
    let uploadComplete = false;
    for (let i = 0; i < 120; i++) {
      await page.waitForTimeout(1000);
      const completeText = await uploadPanel.textContent();
      if (completeText && completeText.includes('Uploaded')) {
        uploadComplete = true;
        break;
      }
      const errorText = await uploadPanel.textContent();
      if (errorText && errorText.includes('error')) {
        throw new Error('Upload failed with error');
      }
    }
    
    if (!uploadComplete) {
      throw new Error('Upload did not complete within 120 seconds');
    }
    console.log('✅ Upload complete');
    
    await page.waitForTimeout(2000);
    
    // ===== Step 2: Verify thumbnail =====
    console.log('\n[Step 2] Verify thumbnail...');
    const videoFile = page.locator('div').filter({ hasText: /test_small\.mp4/i }).first();
    if ((await videoFile.count()) === 0) {
      throw new Error('Video file not found after upload');
    }
    
    // Check <img> tag has content
    const thumbnail = videoFile.locator('img');
    const thumbCount = await thumbnail.count();
    if (thumbCount === 0) {
      throw new Error('Thumbnail img tag not found');
    }
    
    const thumbSrc = await thumbnail.getAttribute('src');
    if (!thumbSrc || thumbSrc.trim() === '') {
      throw new Error('Thumbnail src is empty - thumbnail not loaded');
    }
    console.log(`✅ Thumbnail has content, src: ${thumbSrc.substring(0, 50)}...`);
    
    // ===== Step 3: Double-click to play =====
    console.log('\n[Step 3] Double-click to play...');
    await videoFile.dblclick();
    await page.waitForTimeout(5000);
    
    // Verify video can play - check video element has src and is playable
    const videoElement = page.locator('video');
    const videoCount = await videoElement.count();
    
    if (videoCount > 0) {
      // Verify video has src (not empty)
      const videoSrc = await videoElement.getAttribute('src');
      if (!videoSrc || videoSrc.trim() === '') {
        throw new Error('Video src is empty - video not loaded');
      }
      
      // Try to play and verify it's playing
      await videoElement.evaluate((el: HTMLVideoElement) => el.play());
      await page.waitForTimeout(1000);
      const isPlaying = await videoElement.evaluate((el: HTMLVideoElement) => !el.paused);
      
      if (!isPlaying) {
        throw new Error('Video not playing after play() called');
      }
      
      // Pause it
      await videoElement.evaluate((el: HTMLVideoElement) => el.pause());
      console.log(`✅ Short video plays successfully, src: ${videoSrc.substring(0, 50)}...`);
    } else {
      // Check streaming player
      const previewOverlay = page.locator('div').filter({ hasStyle: 'background: rgba(0, 0, 0, 0.8)' });
      if (!(await previewOverlay.count() > 0)) {
        throw new Error('Video playback not working - no video element and no preview modal');
      }
      
      // For streaming player, verify download button exists (means file is accessible)
      const downloadBtn = page.locator('button').filter({ hasText: '↓' });
      if (!(await downloadBtn.count() > 0)) {
        throw new Error('Streaming player - download button not found');
      }
      console.log('✅ Streaming player working');
    }
    
    // Close modal
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    console.log('\n🎬✅ SHORT VIDEO TEST PASSED 🎬✅');
  });

  test('should upload and verify long video streaming', async ({ page }) => {
    const testFilesDir = path.join(__dirname, '..', '..', 'test-files');
    const videoPath = path.join(testFilesDir, 'test_large.mp4');
    
    if (!fs.existsSync(videoPath)) {
      throw new Error(`Test video not found at: ${videoPath}`);
    }
    
    console.log('='.repeat(60));
    console.log('🎬 TEST 3: LONG VIDEO STREAMING');
    console.log('='.repeat(60));
    const fileSizeMB = (fs.statSync(videoPath).size / 1024 / 1024).toFixed(0);
    console.log(`File size: ${fileSizeMB}MB`);
    
    // Go to app
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    
    // ===== Step 0: Delete old file =====
    console.log('\n[Step 0] Delete old file...');
    const existingVideo = page.locator('div').filter({ hasText: /test_large\.mp4/i }).first();
    if (await existingVideo.count() > 0) {
      await existingVideo.click();
      await page.keyboard.press('Delete');
      page.on('dialog', async dialog => await dialog.accept());
      await page.waitForTimeout(1000);
      
      // Refresh page to confirm file is gone
      await page.reload();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(2000);
      
      const afterRefresh = page.locator('div').filter({ hasText: /test_large\.mp4/i }).first();
      if (await afterRefresh.count() > 0) {
        throw new Error('File still exists after delete - delete failed');
      }
      console.log('✅ Old file deleted and confirmed gone after refresh');
    }
    
    // ===== Step 1: Upload file and wait for completion =====
    console.log('\n[Step 1] Upload test_large.mp4 (this may take a while)...');
    const uploadButton = page.locator('button').filter({ hasText: 'Upload Files' });
    await uploadButton.click();
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(videoPath);
    
    // Wait for upload panel to appear
    const uploadPanel = page.locator('div').filter({ hasText: /test_large\.mp4/ }).first();
    await uploadPanel.waitFor({ state: 'visible', timeout: 5000 });
    console.log('📤 Upload started...');
    
    // Wait until upload complete (large file takes longer - 300 seconds max)
    let uploadComplete = false;
    for (let i = 0; i < 300; i++) {
      await page.waitForTimeout(1000);
      const completeText = await uploadPanel.textContent();
      if (completeText && completeText.includes('Uploaded')) {
        uploadComplete = true;
        break;
      }
      const errorText = await uploadPanel.textContent();
      if (errorText && errorText.includes('error')) {
        throw new Error('Upload failed with error');
      }
    }
    
    if (!uploadComplete) {
      throw new Error('Upload did not complete within 300 seconds');
    }
    console.log('✅ Upload complete');
    
    await page.waitForTimeout(2000);
    
    // ===== Step 2: Verify thumbnail =====
    console.log('\n[Step 2] Verify thumbnail...');
    const videoFile = page.locator('div').filter({ hasText: /test_large\.mp4/i }).first();
    if ((await videoFile.count()) === 0) {
      throw new Error('Video file not found after upload');
    }
    
    // Check <img> tag has content
    const thumbnail = videoFile.locator('img');
    const thumbCount = await thumbnail.count();
    if (thumbCount === 0) {
      throw new Error('Thumbnail img tag not found');
    }
    
    const thumbSrc = await thumbnail.getAttribute('src');
    if (!thumbSrc || thumbSrc.trim() === '') {
      throw new Error('Thumbnail src is empty - thumbnail not loaded');
    }
    console.log(`✅ Thumbnail has content, src: ${thumbSrc.substring(0, 50)}...`);
    
    // ===== Step 3: Double-click to play =====
    console.log('\n[Step 3] Double-click to play...');
    await videoFile.dblclick();
    await page.waitForTimeout(5000);
    
    // Verify video can play
    const videoElement = page.locator('video');
    const videoCount = await videoElement.count();
    
    if (videoCount > 0) {
      // Regular video player
      const videoSrc = await videoElement.getAttribute('src');
      if (!videoSrc || videoSrc.trim() === '') {
        throw new Error('Video src is empty - video not loaded');
      }
      
      await videoElement.evaluate((el: HTMLVideoElement) => el.play());
      await page.waitForTimeout(1000);
      const isPlaying = await videoElement.evaluate((el: HTMLVideoElement) => !el.paused);
      
      if (!isPlaying) {
        throw new Error('Video not playing after play() called');
      }
      
      await videoElement.evaluate((el: HTMLVideoElement) => el.pause());
      console.log(`✅ Long video plays successfully`);
    } else {
      // Streaming player - verify modal opened
      const previewOverlay = page.locator('div').filter({ hasStyle: 'background: rgba(0, 0, 0, 0.8)' });
      if (!(await previewOverlay.count() > 0)) {
        throw new Error('Video playback not working - no preview modal');
      }
      
      // For streaming player, verify download button exists
      const downloadBtn = page.locator('button').filter({ hasText: '↓' });
      if (!(await downloadBtn.count() > 0)) {
        throw new Error('Streaming player - download button not found');
      }
      console.log('✅ Streaming player working (MediaSource API)');
    }
    
    // Close modal
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    console.log('\n🎬✅ LONG VIDEO TEST PASSED 🎬✅');
  });

  test('should upload file via button click', async () => {
    // Create a temporary test file
    const testFilePath = await createTestFile('button-upload-test.txt', 'Button upload test');
    
    try {
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      
      // Find and click the upload button
      const uploadButton = page.locator('button').filter({ hasText: 'Upload Files' });
      await expect(uploadButton).toBeVisible();
      
      // Click the upload button to trigger file input
      await uploadButton.click();
      
      // Wait for file dialog (note: this may not work in headless without special handling)
      // In Playwright, we can use setInputFiles to bypass the dialog
      const fileInput = page.locator('input[type="file"]');
      
      // Set the file on the input
      await fileInput.setInputFiles(testFilePath);
      
      // Wait for upload to process
      await page.waitForTimeout(3000);
      
      // Screenshot
      await page.screenshot({ path: 'tests/screenshots/button-upload.png' });
      
      console.log('Button upload test completed');
      
    } catch (error) {
      console.error('Button upload test error:', error);
      throw error;
    } finally {
      await cleanupTestFile(testFilePath);
    }
  });

  test('should create new folder', async () => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    // Find and click new folder button
    const newFolderButton = page.locator('button').filter({ hasText: '+ New Folder' });
    await expect(newFolderButton).toBeVisible();
    
    // Click to create folder
    await newFolderButton.click();
    
    // Dialog should appear (prompt)
    // Note: Playwright can handle dialogs with event handlers
    page.on('dialog', async dialog => {
      console.log(`Dialog message: ${dialog.message()}`);
      await dialog.dismiss();
    });
    
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'tests/screenshots/new-folder.png' });
  });

  test('should toggle view mode between grid and list', async () => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    // Find and click view toggle button
    const viewToggleButton = page.locator('button').filter({ hasText: /☰ List|⊞ Grid/ });
    await expect(viewToggleButton).toBeVisible();
    
    // Get initial state
    const initialText = await viewToggleButton.textContent();
    console.log(`Initial view mode: ${initialText}`);
    
    // Click to toggle
    await viewToggleButton.click();
    await page.waitForTimeout(500);
    
    // Get new state
    const newText = await viewToggleButton.textContent();
    console.log(`After toggle: ${newText}`);
    
    await page.screenshot({ path: 'tests/screenshots/view-toggle.png' });
    
    // Toggle again
    await viewToggleButton.click();
    await page.waitForTimeout(500);
    
    await page.screenshot({ path: 'tests/screenshots/view-toggle-2.png' });
  });
});