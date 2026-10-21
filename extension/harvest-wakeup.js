/* Browser download events wake the sequential harvester immediately.
 * A bounded timeout remains as a fallback; no click is issued here.
 */
(function(root){
"use strict";
class HarvestWake {
  constructor(schedule=setTimeout,cancel=clearTimeout){
    this.schedule=schedule;
    this.cancel=cancel;
    this.version=0;
    this.waiters=new Set();
  }
  snapshot(){return this.version;}
  notify(){
    this.version++;
    for(const wake of [...this.waiters])wake("download-event");
  }
  wait(previousVersion,timeoutMs){
    if(this.version!==previousVersion)
      return Promise.resolve("download-event");
    const timeout=Math.max(1,Math.min(1000,Number(timeoutMs)||1000));
    return new Promise(resolve=>{
      let timer=null,finished=false;
      const finish=reason=>{
        if(finished)return;
        finished=true;
        this.waiters.delete(finish);
        if(timer!==null)this.cancel(timer);
        resolve(reason);
      };
      this.waiters.add(finish);
      timer=this.schedule(()=>finish("poll-timeout"),timeout);
      if(this.version!==previousVersion)finish("download-event");
    });
  }
}
root.RarRescueHarvestWake=HarvestWake;
})(globalThis);
