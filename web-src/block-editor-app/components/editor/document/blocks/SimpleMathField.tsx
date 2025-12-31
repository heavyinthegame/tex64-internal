"use client"

import React, { useEffect, useRef, useMemo, useState } from "react"
import type { MathfieldElement as MathfieldElementType } from "mathlive"
import { useMathField } from "@/lib/math/MathFieldContext"
import { wrapCjkInMath } from "@/lib/document/serializer"

export type ExtendedMathField = MathfieldElementType & {
  setValue?: (value: string) => void
  getValue?: (format?: string) => string
}

interface SimpleMathFieldProps {
  value: string
  onChange: (value: string) => void
  onFocus?: () => void
  onBlur?: () => void
  onDelete?: () => void
  className?: string
  placeholder?: string
  style?: React.CSSProperties
  asInline?: boolean
  instanceId?: string
  onKeyDown?: (e: KeyboardEvent) => void
  autoFocus?: boolean
}

export const SimpleMathField = React.memo(function SimpleMathField({ 
  value, 
  onChange, 
  onFocus, 
  onBlur,
  onDelete,
  className,
  placeholder,
  style,
  asInline,
  instanceId: providedInstanceId,
  onKeyDown,
  autoFocus,
}: SimpleMathFieldProps) {
  const { registerMathField, unregisterMathField, setActiveMathField, setOpenMathFieldId } = useMathField()
  const mathFieldRef = useRef<ExtendedMathField | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [mathLiveLoaded, setMathLiveLoaded] = useState(false)
  const generatedId = useMemo(() => Math.random().toString(36).slice(2), [])
  const instanceId = providedInstanceId || generatedId
  
  // Use refs for callbacks to avoid re-running effects
  const onChangeRef = useRef(onChange)
  const onFocusRef = useRef(onFocus)
  const onBlurRef = useRef(onBlur)
  const onDeleteRef = useRef(onDelete)
  const onKeyDownRef = useRef(onKeyDown)
  
  useEffect(() => {
    onChangeRef.current = onChange
    onFocusRef.current = onFocus
    onBlurRef.current = onBlur
    onDeleteRef.current = onDelete
    onKeyDownRef.current = onKeyDown
  }, [onChange, onFocus, onBlur, onDelete, onKeyDown])

  const applySelectionBoldStyle = (mathField: ExtendedMathField) => {
    const shadow = mathField.shadowRoot
    if (!shadow || shadow.querySelector('[data-selection-bold]')) return

    const style = document.createElement("style")
    style.setAttribute("data-selection-bold", "true")
    style.textContent = `
      /* Host element transparent background */
      :host {
        background: transparent !important;
        background-color: transparent !important;
      }
      
      /* Default text color - black */
      * {
        color: #000 !important;
      }
      
      /* Selection styling - blue and bold */
      .ML__focused .ML__selected,
      .ML__focused .ML__selected *,
      .ML__focused .ML__selected .ML__contains-caret,
      .ML__focused .ML__selected .ML__smart-fence__close,
      .ML__focused .ML__selected .ML__placeholder {
        font-weight: 800 !important;
        color: #1d4ed8 !important;
        background-color: transparent !important;
        background: transparent !important;
      }
      
      /* FORCE transparent background on ALL elements except caret */
      *:not(.ML__caret) {
        background-color: transparent !important;
        background: transparent !important;
      }
      
      /* Only caret should have color */
      .ML__caret {
        background-color: #3b82f6 !important;
      }
    `
    shadow.appendChild(style)
  }

  // Dynamically import MathLive (client-only)
  useEffect(() => {
    import("mathlive").then((MathLive) => {
      MathLive.renderMathInDocument()
      setMathLiveLoaded(true)
    })
  }, [])

  // Cleanup: unregister on unmount
  useEffect(() => {
    return () => {
      unregisterMathField(instanceId)
    }
  }, [instanceId, unregisterMathField])

  // Set up the math-field element
  useEffect(() => {
    if (!mathLiveLoaded || !containerRef.current) return
    
    // Create math-field if it doesn't exist
    if (!mathFieldRef.current) {
      const mathField = document.createElement("math-field") as unknown as ExtendedMathField
      // Disable MathLive's built-in virtual keyboard completely
      mathField.setAttribute("virtual-keyboard-mode", "off")
      mathField.setAttribute("smart-mode", "false")
      mathField.setAttribute("contenteditable", "true")
      mathField.className = `bg-transparent outline-none ${className || ""}`
      
      // Default styles + custom styles
      mathField.style.cssText = asInline ? `
        display: inline-block;
        min-width: 20px;
        min-height: 20px;
        padding: 2px 4px;
        font-size: 1.1em;
        vertical-align: middle;
        border: 1px solid #cbd5e1;
        border-radius: 4px;
        --caret-color: #3b82f6;
        --selection-color: #1d4ed8;
        --selection-background-color: transparent;
        --contains-highlight-color: currentColor;
        --contains-highlight-background-color: transparent;
      ` : `
        display: block; 
        width: 100%; 
        min-height: 24px; 
        padding: 4px;
        --caret-color: #3b82f6;
        --selection-color: #1d4ed8;
        --selection-background-color: transparent;
        --contains-highlight-color: currentColor;
        --contains-highlight-background-color: transparent;
      `
      
      // Fundamentally disable virtual keyboard
      const mathFieldWithOptions = mathField as unknown as { setOptions?: (options: Record<string, unknown>) => void }
      mathFieldWithOptions.setOptions?.({
        virtualKeyboardMode: "off",
        virtualKeyboards: "",
        virtualKeyboardToggleGlyph: "",
        virtualKeyboardTargetMathfield: null,
        readOnly: false,
        smartMode: false,
        defaultMode: "math",
      })
      
      if (placeholder) {
        // Not directly supported by attribute, but can be set via placeholder prop in newer MathLive or just ignored for now
        // MathLive uses placeholder attribute actually
        mathField.setAttribute("placeholder", placeholder)
      }
      
      // Set initial value
      mathField.value = wrapCjkInMath(value || "")
      
      const stopPropagation = (e: Event) => {
        e.stopPropagation()
      }

      // Track backspace presses when empty
      let emptyBackspaceCount = 0;

      // Listen for changes
      mathField.addEventListener("input", () => {
        const newValue = mathField.value
        // Reset counter on any input
        if (newValue && newValue.trim() !== "") {
           emptyBackspaceCount = 0;
        }
        
        const normalized = wrapCjkInMath(newValue)
        if (normalized !== newValue) {
          if (typeof mathField.setValue === "function") {
            mathField.setValue(normalized)
          } else {
            mathField.value = normalized
          }
        }
        onChangeRef.current(normalized)
      })

      // Prevent Slate from intercepting math-field input (e.g., Backspace)
      // Custom keydown handler
      mathField.addEventListener("keydown", (e) => {
        if (onKeyDownRef.current) {
          onKeyDownRef.current(e)
          if (e.defaultPrevented) {
             return
          }
        }

        if (e.key === "Backspace") {
          const val = mathField.value;
          if (!val || val.trim() === "") {
             // If already empty, check counter
             if (emptyBackspaceCount > 0) {
                 e.preventDefault()
                 e.stopPropagation()
                 if (onDeleteRef.current) onDeleteRef.current()
                 return
             }
             // First backspace on empty field: prevent propagation but don't delete yet
             emptyBackspaceCount++;
             e.stopPropagation() // Stop Slate from deleting it immediately
             return
          } else {
             // Not empty, so this backspace will delete a char. Reset counter.
             emptyBackspaceCount = 0;
          }
        } else {
           // Any other key resets the counter
           emptyBackspaceCount = 0;
        }
        
        // Critical for Inline Math in Slate: stop propagation to prevent Slate from handling keys
        e.stopPropagation()
      })
      mathField.addEventListener("beforeinput", stopPropagation)
      mathField.addEventListener("compositionstart", stopPropagation)
      mathField.addEventListener("compositionupdate", stopPropagation)
      mathField.addEventListener("compositionend", stopPropagation)
      
      // Clipboard events - stop propagation to prevent Slate interference
      mathField.addEventListener("copy", stopPropagation)
      mathField.addEventListener("cut", stopPropagation)
      mathField.addEventListener("paste", stopPropagation)

      // Register with context on focus
      mathField.addEventListener("focus", () => {
        registerMathField(instanceId, mathField)
        setActiveMathField(instanceId)
        setOpenMathFieldId(instanceId)
        if (onFocusRef.current) onFocusRef.current()
      })

      // Clear active on blur
      mathField.addEventListener("blur", () => {
        // Don't unset immediately - allow clicks on keyboard to work
        setTimeout(() => {
          if (document.activeElement !== mathField) {
             if (onBlurRef.current) onBlurRef.current()
          }
        }, 100)
      })
      
      // Fix selection background: aggressively remove all background-color inline styles
      const removeSelectionBackgrounds = () => {
        const allElements = mathField.querySelectorAll('*')
        allElements.forEach((el) => {
          const htmlEl = el as HTMLElement
          if (htmlEl.style && htmlEl.style.backgroundColor) {
            htmlEl.style.backgroundColor = 'transparent'
          }
        })
      }
      
      // Listen for selection changes
      mathField.addEventListener('selection-change', removeSelectionBackgrounds)
      mathField.addEventListener('focus', removeSelectionBackgrounds)
      mathField.addEventListener('click', removeSelectionBackgrounds)
      
      // Use MutationObserver to catch ALL style changes and remove background-color
      const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
            const target = mutation.target as HTMLElement
            if (target.style && target.style.backgroundColor) {
              target.style.backgroundColor = 'transparent'
            }
          }
        })
        removeSelectionBackgrounds()
      })
      observer.observe(mathField, { 
        childList: true, 
        subtree: true, 
        attributes: true,
        attributeFilter: ['style', 'class']
      })
      
      containerRef.current.innerHTML = ""
      containerRef.current.appendChild(mathField)
      mathFieldRef.current = mathField

      // Register immediately
      registerMathField(instanceId, mathField)
    }

    if (mathFieldRef.current) {
      // Ensure latest selection styling is applied even for existing fields
      mathFieldRef.current.style.setProperty("--selection-color", "#1d4ed8")
      mathFieldRef.current.style.setProperty("--selection-background-color", "transparent")
      mathFieldRef.current.style.setProperty("--contains-highlight-color", "currentColor")
      mathFieldRef.current.style.setProperty("--contains-highlight-background-color", "transparent")
      applySelectionBoldStyle(mathFieldRef.current)
      
      // Auto-focus if requested
      if (autoFocus) {
        requestAnimationFrame(() => {
          mathFieldRef.current?.focus()
        })
      }
    }
  }, [className, mathLiveLoaded, instanceId, placeholder, registerMathField, setActiveMathField, autoFocus]) // Removed callbacks, style, and value from deps

  // Update math-field when value changes externally  
  useEffect(() => {
    if (!mathFieldRef.current || !mathLiveLoaded) return
    
    // Skip update if field is focused (user is editing)
    if (document.activeElement === mathFieldRef.current) {
      return
    }
    
    const normalized = wrapCjkInMath(value || "")
    const currentValue = mathFieldRef.current.value
    
    // Skip if values are actually the same
    if (currentValue === normalized) return
    
    // Use requestAnimationFrame for smoother visual update
    const mathField = mathFieldRef.current
    requestAnimationFrame(() => {
      if (mathField && mathField.value !== normalized) {
        mathField.value = normalized
      }
    })
  }, [value, mathLiveLoaded])

  const WrapperTag = asInline ? "span" : "div"
  
  return (
    <WrapperTag className={`relative ${asInline ? "inline-block" : ""}`}>
      <WrapperTag
        ref={containerRef}
        className={className || (asInline ? "inline-block min-w-[30px]" : "w-full min-h-[40px]")}
        style={style}
      >
        {!mathLiveLoaded && (
          <span className="text-slate-400 text-sm p-2">Loading...</span>
        )}
      </WrapperTag>
    </WrapperTag>
  )
}, (prevProps, nextProps) => {
  // Only re-render if value or instanceId changes
  return (
    prevProps.value === nextProps.value &&
    prevProps.instanceId === nextProps.instanceId &&
    prevProps.asInline === nextProps.asInline
  )
})
