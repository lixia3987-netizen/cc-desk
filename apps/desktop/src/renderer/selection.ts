/** 处理较早的 IPC 确认时，保持乐观更新的本地选中状态稳定。 */
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
      // 主进程发起的导航，例如点击通知触发的导航，会覆盖本地点击选择。
      this.revision++;
    }
    return selected;
  }
}
