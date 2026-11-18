package com.spatialmemory.assistant.ui

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Outline
import android.graphics.drawable.GradientDrawable
import android.view.View
import android.view.ViewOutlineProvider
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.ImageView
import androidx.camera.view.PreviewView
import org.json.JSONObject

/** Native pixels under the transparent WebView camera window; controls stay above it. */
internal class CameraPreviewSurface(private val web: WebView) {
    private val host = web.parent as FrameLayout
    private val container = FrameLayout(web.context)
    val phone = PreviewView(web.context).apply {
        implementationMode = PreviewView.ImplementationMode.COMPATIBLE
        scaleType = PreviewView.ScaleType.FILL_CENTER
    }
    private val remote = ImageView(web.context).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
    private var radius = 0f
    private var onScreen = false
    private var active = false

    init {
        host.background = GradientDrawable(GradientDrawable.Orientation.TL_BR,
            intArrayOf(Color.rgb(220,236,248), Color.rgb(237,243,249)))
        container.clipToOutline = true
        container.outlineProvider = object : ViewOutlineProvider() {
            override fun getOutline(view: View, outline: Outline) {
                outline.setRoundRect(0, 0, view.width, view.height, radius)
            }
        }
        container.addView(phone, FrameLayout.LayoutParams(-1,-1))
        container.addView(remote, FrameLayout.LayoutParams(-1,-1))
        host.addView(container, 0, FrameLayout.LayoutParams(1,1))
        web.setBackgroundColor(Color.TRANSPARENT)
        container.visibility = View.INVISIBLE
    }

    fun layout(value: String) {
        val rect = runCatching { JSONObject(value) }.getOrNull() ?: return
        val viewport = rect.optDouble("viewport", 0.0)
        if (!viewport.isFinite() || viewport <= 0) return
        val scale = web.width / viewport
        val x = rect.optDouble("x",0.0) * scale
        val y = rect.optDouble("y",0.0) * scale
        val width = rect.optDouble("width",0.0) * scale
        val height = rect.optDouble("height",0.0) * scale
        if (listOf(x,y,width,height).any { !it.isFinite() } || width <= 0 || height <= 0 ||
            width > web.width * 2 || height > web.height * 2) {
            onScreen = false; updateVisibility(); return
        }
        radius = (rect.optDouble("radius",20.0) * scale).toFloat().coerceIn(0f, width.toFloat()/2)
        container.layoutParams = FrameLayout.LayoutParams(width.toInt(),height.toInt()).apply {
            leftMargin = x.toInt() + web.left - host.paddingLeft
            topMargin = y.toInt() + web.top - host.paddingTop
        }
        container.invalidateOutline()
        onScreen = rect.optBoolean("visible", false)
        updateVisibility()
    }

    fun start(isPhone: Boolean) {
        remote.setImageDrawable(null)
        phone.visibility = if (isPhone) View.VISIBLE else View.GONE
        remote.visibility = if (isPhone) View.GONE else View.VISIBLE
        active = true
        updateVisibility()
    }

    fun display(bitmap: Bitmap) { remote.setImageBitmap(bitmap) }

    fun clear() {
        active = false
        remote.setImageDrawable(null)
        updateVisibility()
    }

    private fun updateVisibility() {
        container.visibility = if (active && onScreen) View.VISIBLE else View.INVISIBLE
    }
}
