import asyncio
import time
# 协程
async def foo():
    print("foo")
    await asyncio.sleep(1)
    print("foo end")

# 任务
async def bar():
    print("bar")
    await asyncio.sleep(2)
    print("bar end")

async def main():
    task1 = asyncio.create_task(foo())
    task2 = asyncio.create_task(bar())
    await task1
    await task2
class Student:
    __age = 18
    def __init__(self):
        self.__name = '我好帅'

def fuc1(f):
    def inner():
        
        start_time = time.time()
        f()
        end_time = time.time()
        duration = end_time - start_time
        print(f'{f.__name__}程序耗时{duration}秒')
    return inner

@fuc1
def fuc2():
    print('你好')
    time.sleep(1)

def func3(f):
    def inner(x,y,z):
        return f(x,y,z)
    return inner
@func3
def func4(x,y,z):
    return max(max(x,y),z)
if __name__ == '__main__':
    asyncio.run(main())
    stu = Student()
    print(stu._Student__age)
    fuc2()
    print(func4(1,2,3))
