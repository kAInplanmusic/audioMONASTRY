import { expect } from '@playwright/test';
import type { RoleContext } from './types';
export async function runRole(ctx: RoleContext) {
 const row=ctx.page.locator('#rack-eq');
 await ctx.page.getByRole('button',{name:'eqMONK An',exact:true}).click();
 await expect(row).toHaveAttribute('data-plugin-mode','ON',{timeout:30000});
 await expect(row).toHaveAttribute('data-plugin-owner','me');
 ctx.record('EQ hold and ON',true,{owner:'me',mode:'ON'});
 const preset=ctx.page.getByLabel('EQ-Preset',{exact:true});
 await expect(preset).toBeVisible({timeout:30000});
 await expect(preset.locator('option')).not.toHaveCount(0,{timeout:30000});
 const options=await preset.locator('option').evaluateAll(items=>items.map(item=>({value:(item as HTMLOptionElement).value,text:item.textContent})).filter(item=>item.value));
 const selected=options.find(option=>!/flat|neutral/i.test(option.text??''))??options[0];
 if(!selected)throw new Error('No actual EQ preset available');
 await preset.selectOption(selected.value);
 await expect(row).toContainText(/Peak\s+[1-9]/,{timeout:15000});
 ctx.record('EQ preset applied through UI',true,selected);
 for(const [role,page]of Object.entries(ctx.pages))if(role!=='eq'){
  await expect(page.locator('#rack-eq')).toHaveAttribute('data-plugin-mode','ON',{timeout:20000});
  await expect(page.locator('#rack-eq')).toHaveAttribute('data-plugin-owner','other');
  for(const label of ['An','Aus','KI-gesteuert']){
   const button=page.getByRole('button',{name:`eqMONK ${label}`,exact:true});
   await expect(button).toBeDisabled();
   await button.evaluate((element:HTMLButtonElement)=>element.click());
  }
  await expect(row).toHaveAttribute('data-plugin-owner','me');
  await expect(row).toHaveAttribute('data-plugin-mode','ON');
  ctx.record(`EQ foreign controls blocked for ${role}`,true,{mode:'ON',owner:'other',disabledClickDidNotMutate:true});
 }
}
