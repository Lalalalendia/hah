/* The MV3 service worker must answer an asynchronous message before Chrome
 * terminates its response channel. This only bounds the wait: it never
 * retries a browser click or a navigation command.
 */
(function(root){
"use strict";
class RarRescueMessageGuard{
  constructor(message,sendResponse,{schedule=setTimeout,cancel=clearTimeout,
      now=Date.now,onTimeout=()=>{}}={}){
    this.started=now();this.now=now;this.sendResponse=sendResponse;
    this.cancel=cancel;this.finished=false;
    this.stage=String(message?.kind||"unknown")+
      (message?.kind==="RR_FRAME_CALL"?"/"+String(message?.payload?.kind||"unknown"):"");
    const slow=message?.kind==="RR_FRAME_CALL"&&
      ["RR_SENSOR_NAV_GOTO","RR_SENSOR_CRAWL_STEP","RR_SENSOR_TRIGGER"].includes(message?.payload?.kind);
    this.deadlineMs=slow?90000:45000;
    this.timer=schedule(()=>{
      const info={stage:this.stage,elapsedMs:this.now()-this.started,
        code:"RR_COMMAND_DEADLINE"};
      this.reply({ok:false,...info,error:"Время ответа команды "+this.stage+
        " истекло. Загрузка/навигация не повторялась; журнал сохранён."});
      try{onTimeout(info);}catch(_){}
    },this.deadlineMs);
  }
  reply(payload){
    if(this.finished)return false;
    this.finished=true;
    this.cancel(this.timer);
    try{this.sendResponse(payload);}catch(_){}
    return true;
  }
}
root.RarRescueMessageGuard=RarRescueMessageGuard;
})(globalThis);
