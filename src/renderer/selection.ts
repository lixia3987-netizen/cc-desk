/** Keep optimistic local selection stable while consuming older IPC acknowledgements. */
export class SessionSelection {
  private serverId:string|undefined;
  private revision=0;
  private pending=new Map<string,number>();
  request(id:string) { this.pending.set(id,++this.revision); }
  navigate(id:string) {this.serverId=id;this.revision++;}
  receive(id:string|undefined):string|undefined {
    const selected=id??'';
    if(selected===this.serverId)return undefined;
    this.serverId=selected;
    const revision=this.pending.get(selected);
    if(revision!==undefined){
      for(const [key,value] of this.pending)if(value<=revision)this.pending.delete(key);
      return undefined;
    }else{
      // A main-process navigation (for example a notification) supersedes local clicks.
      this.revision++;
    }
    return selected;
  }
}
