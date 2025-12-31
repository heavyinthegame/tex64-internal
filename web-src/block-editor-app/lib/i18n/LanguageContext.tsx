"use client"

import React, { createContext, useContext, useEffect, useState } from 'react'
import en from './dictionaries/en.json'
import ja from './dictionaries/ja.json'

type Language = 'en' | 'ja'
type Dictionary = typeof en

const dictionaries: Record<Language, Dictionary> = {
  en,
  ja
}

interface LanguageContextType {
  language: Language
  setLanguage: (lang: Language) => void
  t: (key: string) => string
  dict: Dictionary
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined)

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguage] = useState<Language>('ja')

  useEffect(() => {
    const savedLang = localStorage.getItem('tex64-lang')
    if (savedLang === 'en' || savedLang === 'ja') {
      setLanguage(savedLang)
    }
  }, [])

  const handleSetLanguage = (lang: Language) => {
    setLanguage(lang)
    localStorage.setItem('tex64-lang', lang)
  }

  // Helper to access nested keys like "common.save"
  const t = (key: string): string => {
    const keys = key.split('.')
    let current: unknown = dictionaries[language]
    
    for (const k of keys) {
      if (typeof current !== 'object' || current === null || !(k in current)) {
        console.warn(`Missing translation for key: ${key}`)
        return key
      }
      current = (current as Record<string, unknown>)[k]
    }
    
    return typeof current === 'string' ? current : key
  }

  return (
    <LanguageContext.Provider value={{ language, setLanguage: handleSetLanguage, t, dict: dictionaries[language] }}>
      {children}
    </LanguageContext.Provider>
  )
}

export function useLanguage() {
  const context = useContext(LanguageContext)
  if (context === undefined) {
    throw new Error('useLanguage must be used within a LanguageProvider')
  }
  return context
}
