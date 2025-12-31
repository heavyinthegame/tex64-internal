"use client"

/**
 * MathFieldContext - 数式入力のための統合コンテキスト
 * 
 * 使いやすさ重視の設計:
 * - カーソル位置ベースの検出: ユーザーが実際に編集している場所に数式を挿入
 * - 優先度付きアクティブエディタ: 新しい行の作成直後でも正しい場所に挿入
 * - テキストエディタ登録: 複数のエディタがあっても正確なターゲット特定
 */

import { createContext, useContext, useRef, useCallback, ReactNode, useState, useEffect } from "react"
import type { MathfieldElement as MathfieldElementType } from "mathlive"

interface MathFieldContextType {
  registerMathField: (id: string, ref: MathfieldElementType) => void
  unregisterMathField: (id: string) => void
  getActiveMathField: () => MathfieldElementType | null
  setActiveMathField: (id: string | null) => void
  insertToActive: (latex: string) => boolean // Returns true if inserted, false if no active field
  applyFormatToActive: (format: "bold" | "italic" | "code") => boolean // Returns true if format applied
  setActiveTextEditor: (editor: ActiveTextEditor | null, priority?: boolean) => void
  registerTextEditor: (element: HTMLElement, editor: ActiveTextEditor) => void
  unregisterTextEditor: (element: HTMLElement) => void
  // New: global state for which math field is open
  openMathFieldId: string | null
  setOpenMathFieldId: (id: string | null) => void
  tryAutoOpen: () => boolean
  // Temporary values for robust saving
  setTemporaryValue: (id: string, latex: string) => void
  getTemporaryValue: (id: string) => string | undefined
  clearTemporaryValue: (id: string) => void
}

interface ActiveTextEditor {
  getValue: () => InlineContent[]
  onChange: (value: InlineContent[]) => void
  getCursorPosition?: () => { inlineIndex: number; charOffset: number } | null
  getLatestValue?: () => InlineContent[]
}

// Need to import InlineContent type
import type { InlineContent } from "@/lib/document/types"

const MathFieldContext = createContext<MathFieldContextType | null>(null)

type MathInteractionEvent = {
  target: EventTarget | null
  composedPath?: () => EventTarget[]
}

export const isMathInteractionEvent = (event: MathInteractionEvent) => {
  const path = typeof event.composedPath === "function" ? event.composedPath() : []
  const nodes = path.length > 0 ? path : event.target ? [event.target] : []

  return nodes.some((node) => {
    if (!(node instanceof HTMLElement)) return false
    if (node.tagName === "MATH-FIELD") return true
    if (node.closest?.("math-field")) return true
    if (node.closest?.("[data-math-keyboard]")) return true
    if (node.closest?.("[data-math-preview]")) return true
    return false
  })
}

export function MathFieldProvider({ children }: { children: ReactNode }) {
  const mathFieldsRef = useRef<Map<string, MathfieldElementType>>(new Map())
  const activeIdRef = useRef<string | null>(null)
  const activeTextEditorRef = useRef<ActiveTextEditor | null>(null)
  const temporaryValuesRef = useRef<Map<string, string>>(new Map())
  const [openMathFieldId, setOpenMathFieldId] = useState<string | null>(null)

  // State to track if we should automatically open the next registered math field
  const pendingAutoOpenRef = useRef(false)

  const registerMathField = useCallback((id: string, ref: MathfieldElementType) => {
    mathFieldsRef.current.set(id, ref)
    if (ref instanceof HTMLElement) {
      ref.setAttribute("data-math-field-id", id)
    }
  }, [])
  
  // Method for a newly mounted component to check if it should open itself
  const tryAutoOpen = useCallback(() => {
    if (pendingAutoOpenRef.current) {
      console.log('[MathContext] Consuming pending auto-open')
      pendingAutoOpenRef.current = false
      return true
    }
    return false
  }, [])

  const unregisterMathField = useCallback((id: string) => {
    mathFieldsRef.current.delete(id)
    if (activeIdRef.current === id) {
      activeIdRef.current = null
    }
  }, [])

  const getActiveMathField = useCallback(() => {
    if (!activeIdRef.current) return null
    return mathFieldsRef.current.get(activeIdRef.current) || null
  }, [])

  const setActiveMathField = useCallback((id: string | null) => {
    activeIdRef.current = id
  }, [])

  /**
   * 優先度付きのアクティブエディタ設定
   * 
   * UXの意図:
   * - 新しいリスト行を追加した直後、その行の編集を開始したい
   * - しかしフォーカスイベントのタイミングで別の行が誤ってアクティブになることがある
   * - priority=trueで設定すると、300ms間は他のフォーカスイベントに上書きされない
   * - これにより「項目を追加」→「数式入力」の流れがスムーズになる
   */
  const priorityUntilRef = useRef<number>(0)

  const setActiveTextEditor = useCallback((editor: ActiveTextEditor | null, priority: boolean = false) => {
    const now = Date.now()
    // 優先度保護中は低優先度の設定を無視
    if (!priority && now < priorityUntilRef.current) {
      return // 保護期間中のため無視
    }
    if (priority) {
      // 300msの間、この値を保護
      priorityUntilRef.current = now + 300
    }
    activeTextEditorRef.current = editor
  }, [])

  /**
   * テキストエディタ登録システム
   * 
   * UXの意図:
   * - 複数のSimpleCaptionEditor（段落、リスト項目など）が画面上に存在する
   * - ユーザーがカーソルを置いた場所に正確に数式を挿入したい
   * - 各エディタがDOM要素とともに登録され、カーソル位置から逆引き可能
   */
  const textEditorRegistryRef = useRef<Map<HTMLElement, ActiveTextEditor>>(new Map())

  const registerTextEditor = useCallback((element: HTMLElement, editor: ActiveTextEditor) => {
    textEditorRegistryRef.current.set(element, editor)
  }, [])

  const unregisterTextEditor = useCallback((element: HTMLElement) => {
    const editor = textEditorRegistryRef.current.get(element)
    if (editor && activeTextEditorRef.current === editor) {
      activeTextEditorRef.current = null
    }
    textEditorRegistryRef.current.delete(element)
  }, [])

  const insertToActive = useCallback((latex: string): boolean => {
    const getFocusedMathField = (): MathfieldElementType | null => {
      if (typeof document === "undefined") return null
      const active = document.activeElement
      if (!active || !(active instanceof HTMLElement)) return null
      if (active.tagName === "MATH-FIELD") return active as MathfieldElementType
      const host = active.closest("math-field")
      return host ? (host as MathfieldElementType) : null
    }

    const getRegisteredById = (id: string | null): MathfieldElementType | null => {
      if (!id) return null
      const registered = mathFieldsRef.current.get(id) || null
      if (registered) return registered
      if (typeof document === "undefined") return null
      const selector = `math-field[data-math-field-id="${id}"]`
      const node = document.querySelector(selector)
      return node && node instanceof HTMLElement ? (node as MathfieldElementType) : null
    }

    const insertIntoMathField = (mf: MathfieldElementType, insertLatex: string): boolean => {
      const target = mf as MathfieldElementType & {
        insert?: (s: string, options?: unknown) => boolean
        executeCommand?: (...args: unknown[]) => boolean
        getValue?: (format?: string) => string
        setValue?: (value?: string, options?: unknown) => void
        value?: string
      }

      target.focus?.()

      // executeCommand is the most reliable method in MathLive
      if (typeof target.executeCommand === "function") {
        try {
          // Try standard insert command
          if (target.executeCommand("insert", insertLatex)) {
            // Check if it actually worked (sometimes returns true but does nothing if readonly)
            // But we assume it worked.
            return true
          }
        } catch (e) {
          console.warn("MathLive executeCommand failed:", e)
        }
      }

      // Fallback to insert method
      if (typeof target.insert === "function") {
        try {
          target.insert(insertLatex, { focus: true })
          return true
        } catch (e) {
          console.warn("MathLive insert method failed:", e)
        }
      }
      
      // Fallback to setValue is dangerous as it overwrites content
      // Only use if we can verify current content, but better to avoid if possible.
      // Or append safely.
      const getValue = target.getValue || (target as any).getText // Fallback for older versions
      
      if (typeof target.setValue === "function" && typeof getValue === "function") {
        try {
          const current = getValue.call(target, "latex") ?? target.value ?? ""
          // Append to end of current math
          target.setValue(`${current}${insertLatex}`)
          // Dispatch input for React to pick up
          target.dispatchEvent(new Event("input", { bubbles: true }))
          return true
        } catch (e) {
          console.warn("MathLive setValue fallback failed:", e)
        }
      }
      
      // Last resort: direct property assignment
      if (typeof target.value === "string") {
        target.value = `${target.value}${insertLatex}`
        target.dispatchEvent(new Event("input", { bubbles: true }))
        return true
      }

      return false
    }

    // First, check for a focused math-field (most reliable for cursor placement)
    const focusedField = getFocusedMathField()
    if (focusedField) {
      insertIntoMathField(focusedField, latex)
      return true
    }

    // Next, check for an explicitly open math field (even if focus moved to keyboard)
    const openField = getRegisteredById(openMathFieldId)
    if (openField) {
      insertIntoMathField(openField, latex)
      return true
    }

    // Finally, fallback to the last active registered math field
    const mf = getActiveMathField()
    if (mf) {
      insertIntoMathField(mf, latex)
      return true
    }
    
    // Try to find editor from current cursor position or active focus
    let editor: ActiveTextEditor | undefined
    let targetElement: HTMLElement | undefined

    // 1. Check Selection
    const selection = window.getSelection()
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0)
      let node: Node | null = range.startContainer
      while (node) {
        if (node instanceof HTMLElement) {
          for (const [el, ed] of textEditorRegistryRef.current) {
            if (el.contains(node)) {
              editor = ed
              targetElement = el
              break
            }
          }
        }
        if (editor) break
        node = node.parentNode
      }
    }

    // 2. Check Document Focus (Active Element) - Robust Fallback
    if (!editor && document.activeElement instanceof HTMLElement) {
       for (const [el, ed] of textEditorRegistryRef.current) {
          if (el.contains(document.activeElement)) {
             editor = ed
             targetElement = el
             break
          }
       }
    }

    // 3. Check Active Reference (Final Fallback)
    if (!editor) {
      editor = activeTextEditorRef.current || undefined
      if (editor) {
        // Find element for this editor
        for (const [el, ed] of textEditorRegistryRef.current) {
          if (ed === editor) {
            targetElement = el
            break
          }
        }
      }
    }

    if (editor) {
       // Signal that the next registered field should be opened
       pendingAutoOpenRef.current = true
       
       const prevMathCount = targetElement?.querySelectorAll('[title="クリックして編集"]').length || 0
       
       // Try to split at cursor
       const cursor = editor.getCursorPosition?.()
       let handled = false
       
       if (cursor) {
          const { inlineIndex, charOffset } = cursor
          const currentValue = editor.getLatestValue ? editor.getLatestValue() : editor.getValue()
          if (inlineIndex >= 0 && inlineIndex < currentValue.length) {
             const targetItem = currentValue[inlineIndex];
             if (targetItem.type === "text") {
                const text = targetItem.content
                const beforeText = text.slice(0, charOffset)
                const afterText = text.slice(charOffset)
                const newItems = [...currentValue]
                const newMathId = `math-${Math.random().toString(36).slice(2)}`
                
                const replacementItems: InlineContent[] = []
                if (beforeText) replacementItems.push({ id: `text-${Math.random().toString(36).slice(2)}`, type: "text", content: beforeText, formatting: targetItem.formatting })
                replacementItems.push({ id: newMathId, type: "math", latex })
                if (afterText) replacementItems.push({ id: `text-${Math.random().toString(36).slice(2)}`, type: "text", content: afterText, formatting: targetItem.formatting })
                
                newItems.splice(inlineIndex, 1, ...replacementItems)
                editor.onChange(newItems)
                handled = true
             }
          }
       }

       if (!handled) {
           const currentValue = editor.getLatestValue ? editor.getLatestValue() : editor.getValue()
           // Generate unique ID for stable rendering keys
           const newMathId = `math-${Math.random().toString(36).slice(2)}`
           const newValue = [...currentValue, { id: newMathId, type: "math" as const, latex }]
           editor.onChange(newValue)
       }
       
       // リトライ機構で確実にフォーカス
       const tryClick = (attempt: number) => {
         if (!targetElement) return
         const mathPreviews = targetElement.querySelectorAll('[title="クリックして編集"]')
         if (mathPreviews.length > prevMathCount) {
           const lastMath = mathPreviews[mathPreviews.length - 1] as HTMLElement
           lastMath.click()
         } else if (attempt < 5) {
           setTimeout(() => tryClick(attempt + 1), 50)
         }
       }
       setTimeout(() => tryClick(0), 50)
       return true
    }

    return false
  }, [getActiveMathField, openMathFieldId])

  /**
   * 選択されたテキストにフォーマットを適用
   * 
   * UXの意図:
   * - ツールバーの太字/斜体/コードボタンをクリックすると
   * - 選択されているテキストにそのフォーマットが適用される
   * - 再度クリックするとフォーマットが解除される（トグル動作）
   */
  const applyFormatToActive = useCallback((format: "bold" | "italic" | "code"): boolean => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return false
    }

    const selectedText = selection.toString()
    if (!selectedText) return false

    // Find the editor containing this selection
    const range = selection.getRangeAt(0)
    let editor: ActiveTextEditor | undefined
    let targetElement: HTMLElement | undefined
    let node: Node | null = range.startContainer
    
    while (node) {
      if (node instanceof HTMLElement) {
        for (const [el, ed] of textEditorRegistryRef.current) {
          if (el.contains(node)) {
            editor = ed
            targetElement = el
            break
          }
        }
      }
      if (editor) break
      node = node.parentNode
    }

    if (!editor || !targetElement) return false

    // Get current value
    const currentValue = editor.getLatestValue ? editor.getLatestValue() : editor.getValue()
    
    // Find the inline element that contains the selected text
    const formatKey = format === "code" ? "texttt" : format
    
    // First, check if selection matches an entire inline element (common for toggle)
    for (let i = 0; i < currentValue.length; i++) {
      const item = currentValue[i]
      if (item.type === "text" && item.content === selectedText) {
        // Found exact match - toggle its format
        const currentFormatting = item.formatting || {}
        const hasFormat = !!currentFormatting[formatKey as keyof typeof currentFormatting]
        
        const newFormatting = {
          ...currentFormatting,
          [formatKey]: !hasFormat
        }
        
        const newItems = [...currentValue]
        newItems[i] = { ...item, formatting: newFormatting }
        editor.onChange(newItems)
        return true
      }
    }
    
    // If not exact match, try to split at selection boundaries
    // Find the span with data-inline-index
    let startSpan = range.startContainer instanceof Element 
      ? range.startContainer 
      : range.startContainer.parentElement
    while (startSpan && !startSpan.hasAttribute('data-inline-index')) {
      startSpan = startSpan.parentElement
    }
    
    if (!startSpan) return false
    
    const inlineIndex = parseInt(startSpan.getAttribute('data-inline-index') || '-1')
    if (inlineIndex < 0 || inlineIndex >= currentValue.length) return false
    
    const targetItem = currentValue[inlineIndex]
    if (targetItem.type !== "text") return false
    
    const text = targetItem.content
    const startOffset = range.startOffset
    const endOffset = range.endOffset
    
    if (startOffset >= endOffset || endOffset > text.length) return false
    
    // Split the text
    const beforeText = text.slice(0, startOffset)
    const selectedPart = text.slice(startOffset, endOffset)
    const afterText = text.slice(endOffset)
    
    // Toggle format
    const currentFormatting = targetItem.formatting || {}
    const hasFormat = !!currentFormatting[formatKey as keyof typeof currentFormatting]
    const newFormatting = { ...currentFormatting, [formatKey]: !hasFormat }
    
    // Create new items
    const newItems: InlineContent[] = [...currentValue]
    const replacementItems: InlineContent[] = []
    
    if (beforeText) {
      replacementItems.push({ 
        id: `text-${Math.random().toString(36).slice(2)}`, 
        type: "text", 
        content: beforeText, 
        formatting: targetItem.formatting 
      })
    }
    replacementItems.push({ 
      id: `text-${Math.random().toString(36).slice(2)}`, 
      type: "text", 
      content: selectedPart, 
      formatting: newFormatting 
    })
    if (afterText) {
      replacementItems.push({ 
        id: `text-${Math.random().toString(36).slice(2)}`, 
        type: "text", 
        content: afterText, 
        formatting: targetItem.formatting 
      })
    }
    
    newItems.splice(inlineIndex, 1, ...replacementItems)
    editor.onChange(newItems)
    return true
  }, [])

  // State to track if we should automatically open the next registered math field
  // This solves the focus loss issue when inserting new math:
  // 1. insertToActive sets pendingAutoOpen = true
  // 2. New SimpleCaptionEditor mounts and calls registerMathField
  // 3. registerMathField sees pendingAutoOpen = true and immediately sets openMathFieldId
  // Global state for which math field is currently open
  // Global document click handler to close math fields on outside clicks
  useEffect(() => {
    if (!openMathFieldId) return
    
    const handleClick = (e: MouseEvent) => {
      if (isMathInteractionEvent(e)) return
      setOpenMathFieldId(null)
    }
    
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [openMathFieldId])


  return (
    <MathFieldContext.Provider value={{
      registerMathField,
      unregisterMathField,
      getActiveMathField,
      setActiveMathField,
      insertToActive,
      applyFormatToActive,
      setActiveTextEditor,
      registerTextEditor,
      unregisterTextEditor,
      openMathFieldId,
      setOpenMathFieldId,
      tryAutoOpen,
      // Temporary values for robust saving
      setTemporaryValue: (id: string, latex: string) => {
        temporaryValuesRef.current.set(id, latex)
      },
      getTemporaryValue: (id: string) => {
        return temporaryValuesRef.current.get(id)
      },
      clearTemporaryValue: (id: string) => {
        temporaryValuesRef.current.delete(id)
      }
    }}>
      {children}
    </MathFieldContext.Provider>
  )
}

export function useMathField() {
  const ctx = useContext(MathFieldContext)
  if (!ctx) {
    throw new Error("useMathField must be used within MathFieldProvider")
  }
  return ctx
}
