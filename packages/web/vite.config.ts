import {defineConfig} from 'vite';

// Dev is intentionally fixed to one loopback origin. Never turn arbitrary incoming
// Origin values into trusted API requests; the built web app uses same-origin HTTP.
export default defineConfig({server:{host:'127.0.0.1',port:5173,strictPort:true,proxy:{'/api':{
  target:'http://127.0.0.1:8787',changeOrigin:true,
  configure(proxy){proxy.on('proxyReq',(outgoing,incoming)=>{
    if(incoming.headers.origin==='http://127.0.0.1:5173')outgoing.setHeader('origin','http://127.0.0.1:8787');
  });},
}}}});
