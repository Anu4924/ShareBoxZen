package com.shareboxzen.app;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.view.KeyEvent;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.KeyStore;
import java.util.ArrayList;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public class MainActivity extends Activity implements DownloadListener {

    public static final int PERMISSION_REQUEST_CODE = 1001;
    public static final int FILE_CHOOSER_REQUEST_CODE = 2002;

    public WebView webView;
    public ValueCallback<Uri[]> fileUploadCallback;

    public static class AppWebViewClient extends WebViewClient {
        private final MainActivity activity;

        public AppWebViewClient(MainActivity activity) {
            this.activity = activity;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return false;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            if (activity == null) return super.shouldInterceptRequest(view, request);

            Uri url = request.getUrl();
            if (url != null && "file".equals(url.getScheme())) {
                String path = url.getPath();
                if (path != null) {
                    String cleanPath = path;
                    if (cleanPath.contains("?")) cleanPath = cleanPath.substring(0, cleanPath.indexOf("?"));
                    if (cleanPath.contains("#")) cleanPath = cleanPath.substring(0, cleanPath.indexOf("#"));
                    if (cleanPath.contains("/android_asset/")) {
                        cleanPath = cleanPath.substring(cleanPath.indexOf("/android_asset/") + "/android_asset/".length());
                    }
                    while (cleanPath.startsWith("/")) cleanPath = cleanPath.substring(1);

                    WebResourceResponse resp = tryLoadAsset(activity, cleanPath);
                    if (resp != null) return resp;

                    if (!cleanPath.startsWith("www/")) {
                        resp = tryLoadAsset(activity, "www/" + cleanPath);
                        if (resp != null) return resp;
                    } else {
                        resp = tryLoadAsset(activity, cleanPath.substring(4));
                        if (resp != null) return resp;
                    }
                }
            }
            return super.shouldInterceptRequest(view, request);
        }

        private static WebResourceResponse tryLoadAsset(Activity act, String path) {
            try {
                InputStream is = act.getAssets().open(path);
                String mime = "text/plain";
                if (path.endsWith(".html") || path.endsWith(".htm")) mime = "text/html";
                else if (path.endsWith(".css")) mime = "text/css";
                else if (path.endsWith(".js")) mime = "application/javascript";
                else if (path.endsWith(".png")) mime = "image/png";
                else if (path.endsWith(".jpg") || path.endsWith(".jpeg")) mime = "image/jpeg";
                else if (path.endsWith(".svg")) mime = "image/svg+xml";
                else if (path.endsWith(".json")) mime = "application/json";
                else if (path.endsWith(".ico")) mime = "image/x-icon";

                WebResourceResponse response = new WebResourceResponse(mime, "UTF-8", is);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    java.util.Map<String, String> headers = new java.util.HashMap<>();
                    headers.put("Access-Control-Allow-Origin", "*");
                    headers.put("Cache-Control", "no-cache");
                    response.setResponseHeaders(headers);
                }
                return response;
            } catch (Exception e) {
                return null;
            }
        }

        @Override
        public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
            if (failingUrl != null && failingUrl.startsWith("http")) {
                view.loadUrl("file:///android_asset/www/index.html");
            } else {
                super.onReceivedError(view, errorCode, description, failingUrl);
            }
        }
    }

    public static class GrantPermissionTask implements Runnable {
        private final PermissionRequest request;

        public GrantPermissionTask(PermissionRequest request) {
            this.request = request;
        }

        @Override
        public void run() {
            if (request != null) {
                request.grant(request.getResources());
            }
        }
    }

    public static class AppWebChromeClient extends WebChromeClient {
        private final MainActivity activity;

        public AppWebChromeClient(MainActivity activity) {
            this.activity = activity;
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            if (activity != null) {
                activity.runOnUiThread(new GrantPermissionTask(request));
            }
        }

        @Override
        public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
            if (activity == null) return false;

            if (activity.fileUploadCallback != null) {
                activity.fileUploadCallback.onReceiveValue(null);
            }
            activity.fileUploadCallback = filePathCallback;

            Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("*/*");
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);

            try {
                activity.startActivityForResult(Intent.createChooser(intent, "Select Files to Share"), FILE_CHOOSER_REQUEST_CODE);
                return true;
            } catch (Exception e) {
                activity.fileUploadCallback = null;
                Toast.makeText(activity, "Unable to open file chooser: " + e.getMessage(), Toast.LENGTH_SHORT).show();
                return false;
            }
        }
    }

    public static class SaveFileTask implements Runnable {
        private final MainActivity activity;
        private final String base64Data;
        private final String fileName;
        private final String mimeType;

        public SaveFileTask(MainActivity activity, String base64Data, String fileName, String mimeType) {
            this.activity = activity;
            this.base64Data = base64Data;
            this.fileName = fileName;
            this.mimeType = mimeType;
        }

        @Override
        public void run() {
            try {
                byte[] fileBytes = Base64.decode(base64Data, Base64.DEFAULT);
                String cleanMime = (mimeType != null && !mimeType.isEmpty()) ? mimeType : "application/octet-stream";
                boolean isImage = cleanMime.startsWith("image/");
                boolean isVideo = cleanMime.startsWith("video/");

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentResolver resolver = activity.getContentResolver();
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
                    values.put(MediaStore.MediaColumns.MIME_TYPE, cleanMime);

                    Uri collectionUri;
                    if (isImage) {
                        values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/ShareBoxZen");
                        collectionUri = MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
                    } else if (isVideo) {
                        values.put(MediaStore.Video.Media.RELATIVE_PATH, Environment.DIRECTORY_MOVIES + "/ShareBoxZen");
                        collectionUri = MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
                    } else {
                        values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/ShareBoxZen");
                        collectionUri = MediaStore.Downloads.EXTERNAL_CONTENT_URI;
                    }

                    Uri savedUri = resolver.insert(collectionUri, values);
                    if (savedUri != null) {
                        OutputStream os = resolver.openOutputStream(savedUri);
                        if (os != null) {
                            try {
                                os.write(fileBytes);
                            } finally {
                                os.close();
                            }
                        }
                    }
                } else {
                    File targetDir;
                    if (isImage) {
                        targetDir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "ShareBoxZen");
                    } else if (isVideo) {
                        targetDir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES), "ShareBoxZen");
                    } else {
                        targetDir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "ShareBoxZen");
                    }
                    if (!targetDir.exists()) targetDir.mkdirs();

                    File targetFile = new File(targetDir, fileName);
                    FileOutputStream fos = new FileOutputStream(targetFile);
                    try {
                        fos.write(fileBytes);
                    } finally {
                        fos.close();
                    }
                    MediaScannerConnection.scanFile(activity, new String[]{targetFile.getAbsolutePath()}, new String[]{cleanMime}, null);
                }

                if (isImage || isVideo) {
                    Toast.makeText(activity, "✓ Saved to Albums/Gallery: " + fileName, Toast.LENGTH_LONG).show();
                } else {
                    Toast.makeText(activity, "✓ Saved to My Files / Downloads: " + fileName, Toast.LENGTH_LONG).show();
                }
            } catch (Exception e) {
                Toast.makeText(activity, "Save failed: " + e.getMessage(), Toast.LENGTH_SHORT).show();
            }
        }
    }

    public static class DownloadUrlTask implements Runnable {
        private final MainActivity activity;
        private final String url;
        private final String fileName;
        private final String mimeType;

        public DownloadUrlTask(MainActivity activity, String url, String fileName, String mimeType) {
            this.activity = activity;
            this.url = url;
            this.fileName = fileName;
            this.mimeType = mimeType;
        }

        @Override
        public void run() {
            activity.enqueueDownload(url, null, null, mimeType, fileName);
        }
    }

    public static class NativeFileBridge {
        private final MainActivity activity;

        public NativeFileBridge(MainActivity activity) {
            this.activity = activity;
        }

        @JavascriptInterface
        public boolean isNativeDownloaderAvailable() {
            return true;
        }

        @JavascriptInterface
        public void saveFileToDevice(String base64Data, String fileName, String mimeType) {
            if (base64Data == null || fileName == null) return;
            activity.runOnUiThread(new SaveFileTask(activity, base64Data, fileName, mimeType));
        }

        @JavascriptInterface
        public void downloadFileFromUrl(String url, String fileName, String mimeType, String authHeader) {
            if (url == null) return;
            activity.runOnUiThread(new DownloadUrlTask(activity, url, fileName, mimeType));
        }
    }

    public static class NativeSecureStorageBridge {
        private static final String KEY_ALIAS = "ShareBoxZenSecureAuthKey";
        private static final String PREF_NAME = "shareboxzen_keystore_prefs";
        private static final String PREF_TOKEN = "enc_auth_token";
        private static final String PREF_IV = "enc_auth_iv";

        private final MainActivity activity;

        public NativeSecureStorageBridge(MainActivity activity) {
            this.activity = activity;
            ensureKey();
        }

        private void ensureKey() {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
                    keyStore.load(null);
                    if (!keyStore.containsAlias(KEY_ALIAS)) {
                        KeyGenerator keyGen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
                        keyGen.init(new KeyGenParameterSpec.Builder(
                                KEY_ALIAS,
                                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                                .setRandomizedEncryptionRequired(true)
                                .build());
                        keyGen.generateKey();
                    }
                }
            } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public boolean isNativeStorageAvailable() {
            return true;
        }

        @JavascriptInterface
        public void setAuthToken(String token) {
            if (token == null) return;
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
                    keyStore.load(null);
                    SecretKey key = (SecretKey) keyStore.getKey(KEY_ALIAS, null);

                    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                    cipher.init(Cipher.ENCRYPT_MODE, key);
                    byte[] iv = cipher.getIV();
                    byte[] cipherBytes = cipher.doFinal(token.getBytes("UTF-8"));

                    SharedPreferences prefs = activity.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
                    prefs.edit()
                            .putString(PREF_TOKEN, Base64.encodeToString(cipherBytes, Base64.NO_WRAP))
                            .putString(PREF_IV, Base64.encodeToString(iv, Base64.NO_WRAP))
                            .apply();
                } else {
                    SharedPreferences prefs = activity.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
                    prefs.edit().putString(PREF_TOKEN, token).apply();
                }
            } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public String getAuthToken() {
            try {
                SharedPreferences prefs = activity.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
                String encToken = prefs.getString(PREF_TOKEN, null);
                String encIv = prefs.getString(PREF_IV, null);
                if (encToken == null) return null;

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && encIv != null) {
                    KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
                    keyStore.load(null);
                    SecretKey key = (SecretKey) keyStore.getKey(KEY_ALIAS, null);

                    byte[] iv = Base64.decode(encIv, Base64.NO_WRAP);
                    byte[] cipherBytes = Base64.decode(encToken, Base64.NO_WRAP);

                    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                    cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
                    byte[] plainBytes = cipher.doFinal(cipherBytes);
                    return new String(plainBytes, "UTF-8");
                } else {
                    return encToken;
                }
            } catch (Exception e) {
                return null;
            }
        }

        @JavascriptInterface
        public void clearAuthToken() {
            SharedPreferences prefs = activity.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
            prefs.edit().clear().apply();
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(
                WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
                WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED
        );

        webView = new WebView(this);
        setContentView(webView);

        setupWebSettings();
        setupClients();
        requestAppPermissions();

        Intent intent = getIntent();
        Uri data = intent != null ? intent.getData() : null;
        if (data != null) {
            webView.loadUrl(data.toString());
        } else {
            webView.loadUrl("https://shareboxzen.onrender.com");
        }
    }

    private void setupWebSettings() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
    }

    private void setupClients() {
        webView.setWebViewClient(new AppWebViewClient(this));
        webView.setWebChromeClient(new AppWebChromeClient(this));
        webView.setDownloadListener(this);
        webView.addJavascriptInterface(new NativeFileBridge(this), "ShareBoxAndroid");
        webView.addJavascriptInterface(new NativeSecureStorageBridge(this), "ShareBoxAndroidSecureStorage");
    }

    @Override
    public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimetype, long contentLength) {
        enqueueDownload(url, userAgent, contentDisposition, mimetype, null);
    }

    public void enqueueDownload(String url, String userAgent, String contentDisposition, String mimetype, String customFileName) {
        try {
            String fileName = (customFileName != null && !customFileName.isEmpty())
                    ? customFileName
                    : URLUtil.guessFileName(url, contentDisposition, mimetype);

            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            if (mimetype != null && !mimetype.isEmpty()) request.setMimeType(mimetype);
            if (userAgent != null && !userAgent.isEmpty()) request.addRequestHeader("User-Agent", userAgent);

            request.setTitle(fileName);
            request.setDescription("ShareBoxZen Downloading...");
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);

            DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            if (dm != null) {
                dm.enqueue(request);
                Toast.makeText(this, "Downloading to My Files: " + fileName, Toast.LENGTH_SHORT).show();
            }
        } catch (Exception e) {
            Toast.makeText(this, "Download error: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST_CODE) {
            if (fileUploadCallback == null) return;

            Uri[] results = null;
            if (resultCode == Activity.RESULT_OK && data != null) {
                ClipData clipData = data.getClipData();
                if (clipData != null) {
                    ArrayList<Uri> uris = new ArrayList<>();
                    for (int i = 0; i < clipData.getItemCount(); i++) {
                        uris.add(clipData.getItemAt(i).getUri());
                    }
                    results = uris.toArray(new Uri[0]);
                } else if (data.getData() != null) {
                    results = new Uri[]{ data.getData() };
                }
            }
            fileUploadCallback.onReceiveValue(results);
            fileUploadCallback = null;
        } else {
            super.onActivityResult(requestCode, resultCode, data);
        }
    }

    private void requestAppPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            ArrayList<String> perms = new ArrayList<>();
            if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                perms.add(Manifest.permission.CAMERA);
            }
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
                if (checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                    perms.add(Manifest.permission.READ_EXTERNAL_STORAGE);
                }
                if (checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                    perms.add(Manifest.permission.WRITE_EXTERNAL_STORAGE);
                }
            } else {
                if (checkSelfPermission(Manifest.permission.READ_MEDIA_IMAGES) != PackageManager.PERMISSION_GRANTED) {
                    perms.add(Manifest.permission.READ_MEDIA_IMAGES);
                }
                if (checkSelfPermission(Manifest.permission.READ_MEDIA_VIDEO) != PackageManager.PERMISSION_GRANTED) {
                    perms.add(Manifest.permission.READ_MEDIA_VIDEO);
                }
            }
            if (!perms.isEmpty()) {
                requestPermissions(perms.toArray(new String[0]), PERMISSION_REQUEST_CODE);
            }
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView != null && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }
}
