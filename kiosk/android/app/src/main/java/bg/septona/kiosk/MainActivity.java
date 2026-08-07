package bg.septona.kiosk;

import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

/**
 * Kiosk host activity for the Septona document board.
 *
 * Three things matter on an unattended wall panel and none of them are defaults:
 *   1. the screen must never sleep,
 *   2. the status and navigation bars must stay hidden, and must not come back
 *      permanently the first time somebody swipes the edge of the screen,
 *   3. the WebView must be allowed to use as much storage as it likes, because the
 *      whole document set is cached in IndexedDB for offline reading.
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // The panel is a permanently powered information board, not a tablet.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);

        WebView webView = this.bridge.getWebView();
        if (webView != null) {
            WebSettings s = webView.getSettings();
            s.setDomStorageEnabled(true);
            s.setDatabaseEnabled(true);
            s.setCacheMode(WebSettings.LOAD_DEFAULT);
            // Pinch-zoom on top of the app's own zoom controls only causes confusion.
            s.setSupportZoom(false);
            s.setBuiltInZoomControls(false);
            s.setDisplayZoomControls(false);
            // Ignore any OS-level font scaling: the layout is tuned for a 1080p panel.
            s.setTextZoom(100);
            webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
            webView.setLongClickable(false);
            webView.setHapticFeedbackEnabled(false);
        }

        hideSystemBars();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // Re-assert immersive mode whenever focus returns, otherwise a single edge
        // swipe leaves the navigation bar on screen until the app is restarted.
        if (hasFocus) hideSystemBars();
    }

    @Override
    public void onResume() {
        super.onResume();
        hideSystemBars();
    }

    /** Sticky immersive mode, using the modern API where available. */
    private void hideSystemBars() {
        View decor = getWindow().getDecorView();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            android.view.WindowInsetsController c = decor.getWindowInsetsController();
            if (c != null) {
                c.hide(android.view.WindowInsets.Type.statusBars()
                        | android.view.WindowInsets.Type.navigationBars());
                c.setSystemBarsBehavior(
                        android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            decor.setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        }
    }

    /**
     * The hardware back button would otherwise drop the operator out of the app to the
     * Android home screen. The web layer owns navigation, so back is handled there and
     * never allowed to finish the activity.
     */
    @Override
    public void onBackPressed() {
        WebView webView = this.bridge.getWebView();
        if (webView != null) {
            webView.evaluateJavascript(
                    "window.dispatchEvent(new Event('kioskBack'))", null);
        }
    }
}
