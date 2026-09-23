import React from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/anton'                 // wordmark + VS slam, nothing else
import '@fontsource/space-grotesk/500.css' // headings
import '@fontsource/space-grotesk/600.css'
import '@fontsource/space-grotesk/700.css'
import '@fontsource/inter/400.css'         // interface text AND all numbers (tabular)
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import './styles.css'
import { startMarket } from './engine/prices'
import { initNet } from './engine/net'
import { initRouter } from './engine/route'
import App from './App'

initRouter()    // path routing: link interception + legacy #/ shim
startMarket()   // local chart ambience; server ticks take over when connected
initNet()       // session restore + websocket to the arena server

createRoot(document.getElementById('root')).render(<App />)
