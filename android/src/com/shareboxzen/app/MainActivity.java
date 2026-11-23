package com.shareboxzen.app;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.InputStream;
import java.util.ArrayList;

public class MainActivity extends Activity {

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
                    if (cleanPath.contains("?")) {
                        cleanPath = cleanPath.substring(0, cleanPath.indexOf("?"));
                    }
                    if (cleanPath.contains("#")) {
                        cleanPath = cleanPath.substring(0, cleanPath.indexOf("#"));
                    }
                    if (cleanPath.contains("/android_asset/")) {
                        int idx = cleanPath.indexOf("/android_asset/") + "/android_asset/".length();
                        cleanPath = cleanPath.substring(idx);
                    }
                    while (cleanPath.startsWith("/")) {
                        cleanPath = cleanPath.substring(1);
                    }

                    // 1. Try direct path (e.g. "www/index.html" or "index.html")
                    WebResourceResponse resp = tryLoadAsset(activity, cleanPath);
                    if (resp != null) return resp;

                    // 2. Try with "www/" prefix (e.g. "css/style.css" -> "www/css/style.css")
                    if (!cleanPath.startsWith("www/")) {
                        resp = tryLoadAsset(activity, "www/" + cleanPath);
                        if (resp != null) return resp;
                    } else {
                        // 3. Try without "www/" prefix (e.g. "www/css/style.css" -> "css/style.css")
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
                else if (path.endsWith(".woff2")) mime = "font/woff2";
                else if (path.endsWith(".woff")) mime = "font/woff";
                else if (path.endsWith(".ttf")) mime = "font/ttf";

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
            super.onReceivedError(view, errorCode, description, failingUrl);
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
            String targetUrl = "file:///android_asset/www/index.html";
            try {
                String[] list = getAssets().list("www");
                if (list == null || list.length == 0) {
                    targetUrl = "file:///android_asset/index.html";
                }
            } catch (Exception ignored) {}
            webView.loadUrl(targetUrl);
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
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST_CODE) {
            if (fileUploadCallback == null) return;

            Uri[] results = null;
            if (resultCode == Activity.RESULT_OK && data != null) {
                ClipData clipData = data.getClipData();
                if (clipData != null) {
                    ArrayList<Uri> uris = new ArrayList<Uri>();
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
            ArrayList<String> perms = new ArrayList<String>();
            if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                perms.add(Manifest.permission.CAMERA);
            }
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
                if (checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                    perms.add(Manifest.permission.READ_EXTERNAL_STORAGE);
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
