export function read<T>(key:string,fallback:T):T{try{const v=localStorage.getItem('ug3:'+key);return v?JSON.parse(v) as T:fallback}catch{return fallback}}
export function write<T>(key:string,value:T):boolean{try{localStorage.setItem('ug3:'+key,JSON.stringify(value));return true}catch(err){console.warn('Local storage write failed (quota or private mode):',key,err);return false}}
