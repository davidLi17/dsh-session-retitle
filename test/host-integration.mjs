// Real installed DSH Session, projection, AgentRegistry and SessionTitle service.
// LLM output is deterministic: no account, network model call or user session.
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import Projection from '@deepseek-ai/dsh-session-projection';
import Agents from '@deepseek-ai/dsh-agent';
import SessionTitle from '@deepseek-ai/dsh-session-title';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createStatus, retitleOnce } from '../lib/index.js';
import { normalizeConfig } from '../lib/retitle.js';
const ctx=new Context();ctx.logger.level=0;
let count=0;const check=(name,fn)=>{fn();count++;console.log('  ok '+name)};
try {
 const session=Session.create(SessionId('retitle-host-compat'));
 ctx.provide('sessions',{get:id=>id===session.id?session:undefined});
 await ctx.plugin(Projection);await ctx.plugin(Agents);
 await ctx.plugin(SessionTitle,{fallbackMaxWords:10,fallbackMaxBytes:80,maxTitleBytes:80});
 session.append('user/message',createUserMessage({content:[{type:'text',text:'保留我的会话内容'}],source:{kind:'user'}}),{surfaceOp:'append'});
 const history=session.snapshotEvents();
 const services={sessions:ctx.sessions,sessionTitle:ctx.sessionTitle,llm:{async *stream(){yield {type:'text-delta',index:0,text:'自动命名'};yield {type:'finish',reason:'stop'};}}};
 const call=title=>retitleOnce({services,sessionId:session.id,title,config:normalizeConfig({}),status:createStatus()});
 await call('手动标题');
 check('official title service accepts manual rename',()=>assert.equal(ctx.sessionTitle.get(session).title,'手动标题'));
 check('manual rename stays user-owned',()=>assert.equal(ctx.sessionTitle.get(session).source.kind,'user'));
 check('rename preserves prior log',()=>assert.deepEqual(session.snapshotEvents().slice(0,history.length),history));
 await assert.rejects(()=>call(''),e=>e.code==='no-model-route');count++;
 check('no model does not replace old title',()=>assert.equal(ctx.sessionTitle.get(session).title,'手动标题'));
 session.append('request/header',{header:{config:{provider:'fixture-provider',model:'fixture-model'}}});
 const result=await call('');
 check('snapshotEvents digest works with real Session',()=>assert.equal(result.digest.items,1));
 check('AI path stays on target session model',()=>assert.equal(result.route.model,'fixture-model'));
 check('AI title writes through official service',()=>assert.equal(ctx.sessionTitle.get(session).title,'自动命名'));
 console.log(`${count} real DSH retitle integration checks passed (fixture LLM; no live model/UI)`);
} finally {await ctx.fiber.dispose()}
